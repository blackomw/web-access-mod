#!/usr/bin/env node
import { WebSocket } from 'ws';

const TARGET_ID = process.argv[2] || '694FFBD312850E41F2F6E9FAA5B282DF';
const CHROME_PORT = 59042;

async function main() {
  const ws = new WebSocket(`ws://127.0.0.1:${CHROME_PORT}/devtools/browser`);
  
  let wsSession = null;
  let cmdId = 0;
  const pending = new Map();

  await new Promise(r => ws.on('open', r));

  function send(method, params = {}, session = null) {
    return new Promise((resolve) => {
      const id = ++cmdId;
      pending.set(id, { resolve });
      const payload = { id, method, params };
      if (session) payload.sessionId = session;
      ws.send(JSON.stringify(payload));
    });
  }

  async function getResponseBody(requestId) {
    try {
      const resp = await send('Network.getResponseBody', { requestId }, wsSession);
      return resp.result?.body || null;
    } catch (e) {
      return null;
    }
  }

  let messageHandler;
  ws.on('message', messageHandler = (data) => {
    const msg = JSON.parse(data.toString());
    
    if (msg.method === 'Target.attachedToTarget') {
      wsSession = msg.params.sessionId;
      console.log('[+] Attached, session:', wsSession);
      enableNetwork();
    }
    
    if (msg.id && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  });

  async function enableNetwork() {
    await send('Network.enable', {}, wsSession);
    console.log('[+] Network enabled\n');
    
    ws.on('message', async (data) => {
      const msg = JSON.parse(data.toString());
      
      if (msg.method === 'Network.requestWillBeSent') {
        const req = msg.params;
        if (req.request.url.includes('api')) {
          console.log(`\n========== REQUEST ==========`);
          console.log('URL:', req.request.url);
          console.log('Method:', req.request.method);
          console.log('Post Data:', req.request.postData || '(none)');
          console.log('Request ID:', req.requestId);
        }
      }
      
      if (msg.method === 'Network.responseReceived') {
        const res = msg.params.response;
        if (res.url.includes('api') && res.status >= 200 && res.status < 300) {
          console.log('Status:', res.status, res.statusText);
          const body = await getResponseBody(msg.params.requestId);
          if (body) {
            console.log('Response Body:', body.slice(0, 1500));
          }
          console.log('=========================================\n');
        }
      }
    });
  }

  wsSession = (await send('Target.attachToTarget', { targetId: TARGET_ID, flatten: true })).result?.sessionId;
  if (!wsSession) {
    console.log('Failed to get session');
    process.exit(1);
  }
  console.log('Session:', wsSession);
  enableNetwork();
}

main().catch(console.error);
