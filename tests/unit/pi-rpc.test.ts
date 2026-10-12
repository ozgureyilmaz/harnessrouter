import test from 'node:test';
import assert from 'node:assert/strict';
import { PiRpcClient } from '../../src/transport/pi-rpc.js';

const fakePiProgram = String.raw`
let pending = '';
const send = (record) => process.stdout.write(JSON.stringify(record) + '\n');
process.stdin.on('data', (chunk) => {
  pending += chunk.toString('utf8');
  let boundary;
  while ((boundary = pending.indexOf('\n')) >= 0) {
    const line = pending.slice(0, boundary);
    pending = pending.slice(boundary + 1);
    if (!line) continue;
    const command = JSON.parse(line);
    if (command.type === 'get_state') {
      send({ type: 'response', id: command.id, command: command.type, success: true, data: { model: { provider: 'test-provider', id: 'test-model' } } });
    } else if (command.type === 'set_auto_retry') {
      send({ type: 'response', id: command.id, command: command.type, success: true });
    } else if (command.type === 'prompt') {
      send({ type: 'response', id: command.id, command: command.type, success: true, data: { disposition: 'started' } });
      const text = 'first' + String.fromCharCode(0x2028) + 'second';
      setTimeout(() => {
        send({ type: 'tool_execution_end', toolName: 'browser_open', isError: false, durationMs: 12 });
        send({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }] } });
        send({ type: 'agent_settled', aborted: false });
      }, 5);
    } else if (command.type === 'abort') {
      send({ type: 'response', id: command.id, command: command.type, success: true });
    } else {
      send({ type: 'response', id: command.id, command: command.type, success: false });
    }
  }
});
`;

test('Pi RPC correlates commands and splits protocol records only on LF', async (t) => {
  const client = new PiRpcClient({
    command: process.execPath,
    args: ['-e', fakePiProgram],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
  });
  t.after(async () => client.close());

  const state = await client.request('get_state', {}, { timeoutMs: 2_000 });
  assert.equal((state.data as { model: { provider: string } }).model.provider, 'test-provider');
  await client.request('set_auto_retry', { enabled: false }, { timeoutMs: 2_000 });

  const settled = client.waitForEvent('agent_settled', { timeoutMs: 2_000 });
  const accepted = await client.request('prompt', { message: 'safe fixture task' }, { timeoutMs: 2_000 });
  assert.equal((accepted.data as { disposition: string }).disposition, 'started');
  const end = await settled;
  assert.equal(end.aborted, false);
  const finalMessage = client.finalAssistantMessage as { content: Array<{ text: string }> };
  assert.equal(finalMessage.content[0].text, `first${String.fromCharCode(0x2028)}second`);
  assert.deepEqual(client.toolCalls, [{ name: 'browser_open', failed: false, durationMs: 12 }]);
  assert.equal(client.stderrByteCount, 0);
});

test('Pi RPC rejects malformed records without logging their content', async (t) => {
  const badPiProgram = String.raw`
process.stdin.on('data', () => process.stdout.write('{malformed-secret-free-fixture}\n'));
`;
  const client = new PiRpcClient({
    command: process.execPath,
    args: ['-e', badPiProgram],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    maxRecordBytes: 128,
  });
  t.after(async () => client.close());
  await assert.rejects(client.request('get_state', {}, { timeoutMs: 1_000 }), /malformed JSON/);
});

test('mocked Pi RPC: request timeout releases its pending waiter', async (t) => {
  const client=new PiRpcClient({command:process.execPath,args:['-e',"process.stdin.on('data',()=>{});"],cwd:process.cwd(),env:{PATH:process.env.PATH??'/usr/bin:/bin'}});
  t.after(()=>client.close());
  await assert.rejects(client.request('get_state',{}, {timeoutMs:50}),error=>(error as {code:string}).code==='PI_RPC_TIMEOUT');
});

test('mocked Pi RPC: cancellation stops an active event wait', async (t) => {
  const client=new PiRpcClient({command:process.execPath,args:['-e',"process.stdin.on('data',()=>{});"],cwd:process.cwd(),env:{PATH:process.env.PATH??'/usr/bin:/bin'}});
  t.after(()=>client.close());await client.start();const controller=new AbortController();
  const wait=client.waitForEvent('agent_settled',{signal:controller.signal,timeoutMs:1000});controller.abort();
  await assert.rejects(wait,error=>(error as {code:string}).code==='PI_RPC_CANCELLED');
});

test('mocked Pi RPC: process crash promptly rejects both command and agent wait', async (t) => {
  const client=new PiRpcClient({command:process.execPath,args:['-e',"process.stdin.once('data',()=>process.exit(7));"],cwd:process.cwd(),env:{PATH:process.env.PATH??'/usr/bin:/bin'}});
  t.after(()=>client.close());await client.start();
  const results=await Promise.allSettled([client.waitForEvent('agent_settled',{timeoutMs:1000}),client.request('prompt',{message:'fixture'},{timeoutMs:1000})]);
  assert.ok(results.every(r=>r.status==='rejected'&&r.reason.code==='PI_RPC_EXITED'));
});
