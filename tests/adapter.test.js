/** Local SSE transport validates actual request and stream projection without account access. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'

test('projects text, reasoning, tool arguments and results through the Chat Completions wire', async t => {
  const seen = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    seen.push(JSON.parse(body))
    assert.equal(req.headers.authorization, 'Bearer test-only-token')
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const chunks = [
      { choices: [{ delta: { reasoning_content: 'checking' } }] },
      { choices: [{ delta: { content: 'Hello' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read', arguments: '{"path":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"file"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 12, completion_tokens: 3 } },
    ]
    for (const value of chunks) res.write(`data: ${JSON.stringify(value)}\n\n`)
    res.end('data: [DONE]\n\n')
  })
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const prior = process.env.WORKBUDDY_BASE_URL
  process.env.WORKBUDDY_BASE_URL = `http://127.0.0.1:${server.address().port}`
  t.after(() => { if (prior === undefined) delete process.env.WORKBUDDY_BASE_URL; else process.env.WORKBUDDY_BASE_URL = prior })
  const { apply } = await import('../index.js')
  let adapter
  apply({ llm: { registerAdapter: (_providers, value) => { adapter = value } } }, { apiKey: 'test-only-token' })
  const call = await adapter.prepareCall('workbuddy', 'deepseek-v3-2-volc')
  const chunks = []
  for await (const chunk of call.stream({ provider: 'workbuddy', model: 'deepseek-v3-2-volc', messages: [
    { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'previous', name: 'read', arguments: '{}' }] },
    { role: 'tool', toolCallId: 'previous', content: [{ type: 'text', text: 'data' }] },
  ], tools: [{ name: 'read', description: 'Read', parameters: { type: 'object' } }], signal: new AbortController().signal })) chunks.push(chunk)
  assert.equal(seen[0].tools[0].function.name, 'read')
  assert.equal(seen[0].messages[2].tool_call_id, 'previous')
  assert.ok(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'Hello'))
  const tool = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
  assert.deepEqual(JSON.parse(tool.block.arguments), { path: 'file' })
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
})
