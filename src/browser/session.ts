import type { Browser, BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright';
import { createAllowlistProxy, type AllowlistProxy } from './allowlist-proxy.js';
import { assertAllowedUrl, normalizeAllowedDomains } from './policy.js';
import { evaluationFixtureResponse, parseEvaluationFixture, type EvaluationFixture } from './eval-fixture.js';
import { sanitizeMeasuredLinks, type MeasuredLink } from './measured-links.js';

const BROWSER_ARGS = [
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-sync',
  '--disable-quic',
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
  '--no-first-run',
  '--no-default-browser-check',
];

export interface BrowserSessionOptions {
  allowedDomains: readonly string[];
  chromeChannel?: string;
  operationTimeoutMs?: number;
  evaluationFixture?: EvaluationFixture;
}

export interface PageObservation {
  url: string;
  title: string;
  text: string;
  textTruncated: boolean;
  visualStyle: {
    viewport: { width: number; height: number };
    palette: { pageBackground: string; bodyText: string; heading: string | null; link: string | null };
    typography: {
      bodyFontFamily: string;
      bodyFontSize: string;
      bodyLineHeight: string;
      headingFontFamily: string | null;
      headingFontSize: string | null;
      headingFontWeight: string | null;
    };
    layout: { mainContentBox: { x: number; y: number; width: number; height: number } | null };
  };
  links: MeasuredLink[];
}

export class BrowserSession {
  readonly allowedDomains: string[];
  readonly evaluationFixture?: EvaluationFixture;
  private readonly chromeChannel: string;
  private readonly operationTimeoutMs: number;
  private proxy?: AllowlistProxy;
  private browser?: Browser;
  private context?: BrowserContext;
  private currentPage?: Page;
  private closed = false;
  private evaluationFixtureServed = false;

  constructor(options: BrowserSessionOptions) {
    this.allowedDomains = normalizeAllowedDomains(options.allowedDomains);
    this.evaluationFixture = options.evaluationFixture
      ? parseEvaluationFixture(options.evaluationFixture)
      : undefined;
    if (this.evaluationFixture && !this.allowedDomains.includes('example.com')) {
      throw new Error('Evaluation fixtures require example.com in the exact browser allowlist.');
    }
    this.chromeChannel = options.chromeChannel ?? 'chrome';
    this.operationTimeoutMs = options.operationTimeoutMs ?? 10_000;
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error('Browser session is closed.');
    if (this.browser) return;
    this.proxy = await createAllowlistProxy(this.allowedDomains);
    try {
      this.browser = await chromium.launch({
        channel: this.chromeChannel,
        headless: true,
        chromiumSandbox: true,
        proxy: {
          server: this.proxy.server,
          username: this.proxy.username,
          password: this.proxy.password,
          // Chromium normally bypasses proxies for loopback. Remove that
          // implicit exception so even local destinations reach the deny gate.
          bypass: '<-loopback>',
        },
        args: BROWSER_ARGS,
        timeout: this.operationTimeoutMs,
      });
      this.context = await this.browser.newContext({
        acceptDownloads: false,
        ignoreHTTPSErrors: false,
        javaScriptEnabled: true,
        permissions: [],
        serviceWorkers: 'block',
      });
      await this.context.route('**/*', async (route) => {
        if (this.evaluationFixture) {
          const request = route.request();
          const response = evaluationFixtureResponse(this.evaluationFixture, {
            url: request.url(),
            resourceType: request.resourceType(),
            isNavigationRequest: request.isNavigationRequest(),
            isMainFrame: request.isNavigationRequest() && request.frame() === this.currentPage?.mainFrame(),
          }, this.evaluationFixtureServed);
          if (!response) {
            await route.abort('blockedbyclient').catch(() => undefined);
            return;
          }
          this.evaluationFixtureServed = true;
          await route.fulfill(response);
          return;
        }
        try {
          assertAllowedUrl(route.request().url(), this.allowedDomains);
          await route.continue();
        } catch {
          await route.abort('blockedbyclient').catch(() => undefined);
        }
      });
      this.context.on('page', (page) => {
        if (!this.currentPage) {
          this.currentPage = page;
          this.attachPageGuards(page);
          return;
        }
        if (page !== this.currentPage) void page.close().catch(() => undefined);
      });
      this.currentPage = await this.context.newPage();
      this.currentPage.setDefaultTimeout(this.operationTimeoutMs);
      this.currentPage.setDefaultNavigationTimeout(this.operationTimeoutMs);
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async navigate(rawUrl: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const url = assertAllowedUrl(rawUrl, this.allowedDomains);
    if (this.evaluationFixture && rawUrl !== this.evaluationFixture.url) {
      throw new Error('Evaluation browser sessions may open only their exact host-owned fixture URL.');
    }
    await this.start();
    signal?.throwIfAborted();
    const page = this.requirePage();
    await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: this.operationTimeoutMs, signal });
    signal?.throwIfAborted();
    const currentUrl = page.url();
    assertAllowedUrl(currentUrl, this.allowedDomains);
    return currentUrl;
  }

  async extract(signal?: AbortSignal): Promise<PageObservation> {
    signal?.throwIfAborted();
    const page = this.requirePage();
    const url = page.url();
    assertAllowedUrl(url, this.allowedDomains);
    const [title, visual] = await Promise.all([
      page.title(),
      page.locator('body').evaluate((body) => {
        const bodyElement = body instanceof HTMLElement ? body : document.body;
        const visibleText = bodyElement.innerText;
        const bodyStyle = getComputedStyle(bodyElement);
        const rootStyle = getComputedStyle(document.documentElement);
        const heading = document.querySelector('h1');
        const link = document.querySelector('a');
        const headingStyle = heading ? getComputedStyle(heading) : undefined;
        const linkStyle = link ? getComputedStyle(link) : undefined;
        const bodyBackground = bodyStyle.backgroundColor;
        const pageBackground = bodyBackground && bodyBackground !== 'rgba(0, 0, 0, 0)'
          ? bodyBackground
          : rootStyle.backgroundColor;
        const anchors = [...document.querySelectorAll('a')].slice(0, 24).map((anchor) => ({
          text: (anchor.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200),
          href: anchor instanceof HTMLAnchorElement ? anchor.href : '',
        }));
        return {
          visibleText: visibleText.slice(0, 12_000),
          textTruncated: visibleText.length > 12_000,
          links: anchors,
          palette: {
            pageBackground: pageBackground || 'unknown',
            bodyText: bodyStyle.color || 'unknown',
            heading: headingStyle?.color ?? null,
            link: linkStyle?.color ?? null,
          },
          typography: {
            bodyFontFamily: bodyStyle.fontFamily.slice(0, 200),
            bodyFontSize: bodyStyle.fontSize,
            bodyLineHeight: bodyStyle.lineHeight,
            headingFontFamily: headingStyle?.fontFamily.slice(0, 200) ?? null,
            headingFontSize: headingStyle?.fontSize ?? null,
            headingFontWeight: headingStyle?.fontWeight ?? null,
          },
        };
      }, undefined, { timeout: this.operationTimeoutMs, signal }),
    ]);
    const main = page.locator('main').first();
    const mainBox = await (await main.count() ? main : page.locator('body')).boundingBox();
    const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
    signal?.throwIfAborted();
    const text = visual.visibleText;
    return {
      url,
      title: title.slice(0, 500),
      text,
      textTruncated: visual.textTruncated,
      visualStyle: {
        viewport,
        palette: visual.palette,
        typography: visual.typography,
        layout: { mainContentBox: mainBox ? {
          x: Math.round(mainBox.x),
          y: Math.round(mainBox.y),
          width: Math.round(mainBox.width),
          height: Math.round(mainBox.height),
        } : null },
      },
      links: sanitizeMeasuredLinks(visual.links),
    };
  }

  /** Independent page oracle used to freeze reference evidence before agent trials. */
  async captureOracleReference(screenshotPath: string, signal?: AbortSignal): Promise<PageObservation> {
    signal?.throwIfAborted();
    const page = this.requirePage();
    const url = page.url();
    assertAllowedUrl(url, this.allowedDomains);
    if (this.evaluationFixture && url !== this.evaluationFixture.url) {
      throw new Error('Evaluation reference page does not match its host-owned fixture URL.');
    }

    const title = await page.title();
    const data = await page.locator('body').evaluate((body) => {
      const bodyElement = body instanceof HTMLElement ? body : document.body;
      const visibleText = bodyElement.innerText;
      const bodyStyle = getComputedStyle(bodyElement);
      const rootStyle = getComputedStyle(document.documentElement);
      const heading = document.querySelector('h1');
      const firstLink = document.querySelector('a');
      const headingStyle = heading ? getComputedStyle(heading) : undefined;
      const linkStyle = firstLink ? getComputedStyle(firstLink) : undefined;
      const bodyBackground = bodyStyle.backgroundColor;
      const anchors = [...document.querySelectorAll('a')].slice(0, 24).map((anchor) => ({
        text: (anchor.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200),
        href: anchor instanceof HTMLAnchorElement ? anchor.href : '',
      }));
      return {
        visibleText: visibleText.slice(0, 12_000),
        textTruncated: visibleText.length > 12_000,
        links: anchors,
        palette: {
          pageBackground: bodyBackground && bodyBackground !== 'rgba(0, 0, 0, 0)' ? bodyBackground : rootStyle.backgroundColor,
          bodyText: bodyStyle.color || 'unknown',
          heading: headingStyle?.color ?? null,
          link: linkStyle?.color ?? null,
        },
        typography: {
          bodyFontFamily: bodyStyle.fontFamily.slice(0, 200), bodyFontSize: bodyStyle.fontSize,
          bodyLineHeight: bodyStyle.lineHeight, headingFontFamily: headingStyle?.fontFamily.slice(0, 200) ?? null,
          headingFontSize: headingStyle?.fontSize ?? null, headingFontWeight: headingStyle?.fontWeight ?? null,
        },
      };
    }, undefined, {timeout: this.operationTimeoutMs, signal});
    const main = page.locator('main').first();
    const mainBox = await (await main.count() ? main : page.locator('body')).boundingBox();
    const viewport = page.viewportSize() ?? {width: 1280, height: 720};
    await page.screenshot({path: screenshotPath, fullPage: false, animations: 'disabled', timeout: this.operationTimeoutMs, signal, type: 'png'});
    signal?.throwIfAborted();
    return {
      url, title: title.slice(0, 500), text: data.visibleText, textTruncated: data.textTruncated,
      visualStyle: {
        viewport, palette: data.palette, typography: data.typography,
        layout: {mainContentBox: mainBox ? {x: Math.round(mainBox.x), y: Math.round(mainBox.y), width: Math.round(mainBox.width), height: Math.round(mainBox.height)} : null},
      },
      links: sanitizeMeasuredLinks(data.links),
    };
  }

  async screenshot(path: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const page = this.requirePage();
    assertAllowedUrl(page.url(), this.allowedDomains);
    await page.screenshot({
      path,
      fullPage: false,
      animations: 'disabled',
      timeout: this.operationTimeoutMs,
      signal,
      type: 'png',
    });
    signal?.throwIfAborted();
  }

  async currentUrl(): Promise<string | undefined> {
    const url = this.currentPage?.url();
    if (!url || url === 'about:blank') return undefined;
    assertAllowedUrl(url, this.allowedDomains);
    return url;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.context?.close();
    } catch {
      // Continue cleanup so an error in Chrome shutdown does not leave proxy open.
    }
    try {
      await this.browser?.close();
    } catch {
      // Continue cleanup.
    }
    await this.proxy?.close().catch(() => undefined);
    this.context = undefined;
    this.browser = undefined;
    this.proxy = undefined;
    this.currentPage = undefined;
  }

  private requirePage(): Page {
    if (!this.currentPage || this.currentPage.isClosed()) {
      throw new Error('Open an approved public URL before using browser tools.');
    }
    return this.currentPage;
  }

  private attachPageGuards(page: Page): void {
    page.on('dialog', (dialog) => void dialog.dismiss().catch(() => undefined));
    page.on('download', (download) => void download.cancel().catch(() => undefined));
  }
}
