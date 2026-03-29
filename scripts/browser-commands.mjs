#!/usr/bin/env node
/**
 * browser-commands.mjs - 实现bb-browser风格的浏览器控制命令
 * 功能：
 * 1. 页面信息：get text|url|title <ref>
 * 2. 导航：back / forward / refresh
 * 3. 调试：network requests [filter] / console [--clear] / errors [--clear]
 * 
 * 通过现有的cdp-proxy HTTP API实现
 */

import http from 'node:http';
import { URL } from 'node:url';

const PROXY_PORT = parseInt(process.env.CDP_PROXY_PORT || '3456');
const PROXY_URL = `http://127.0.0.1:${PROXY_PORT}`;

// --- HTTP请求工具 ---
function httpGet(path) {
  return new Promise((resolve, reject) => {
    http.get(`${PROXY_URL}${path}`, { timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data);
        }
      });
    }).on('error', reject);
  });
}

function httpPost(path, body) {
  return new Promise((resolve, reject) => {
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request(`${PROXY_URL}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 10000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data);
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// --- 获取当前活动tab ---
async function getCurrentTarget() {
  try {
    const targets = await httpGet('/targets');
    if (targets && targets.length > 0) {
      // 优先返回attached的页面target
      const attached = targets.find(t => t.type === 'page' && t.attached);
      if (attached) return attached;
      
      // 其次返回非chrome://的页面target
      const nonChrome = targets.find(t => 
        t.type === 'page' && 
        !t.url.startsWith('chrome://') &&
        !t.url.startsWith('devtools://')
      );
      if (nonChrome) return nonChrome;
      
      // 最后返回第一个页面target
      return targets.find(t => t.type === 'page') || targets[0];
    }
  } catch (e) {
    console.error('获取targets失败:', e.message);
  }
  return null;
}

// --- 命令处理器 ---

/**
 * get命令：获取页面内容
 * get text <ref> - 获取元素文本
 * get url - 获取当前URL
 * get title - 获取页面标题
 */
async function getCommand(args) {
  const attribute = args[0];
  if (!attribute) {
    console.error('用法: get text|url|title [ref]');
    process.exit(1);
  }

  const target = await getCurrentTarget();
  if (!target) {
    console.error('未找到活动的页面tab');
    process.exit(1);
  }

  let expression;
  if (attribute === 'url') {
    expression = 'location.href';
  } else if (attribute === 'title') {
    expression = 'document.title';
  } else if (attribute === 'text') {
    const ref = args[1];
    if (!ref) {
      console.error('获取文本需要ref参数，如: get text @5');
      process.exit(1);
    }
    // ref是元素索引，通过snapshot获取
    // 这里简化处理：假设ref是CSS选择器
    expression = `(function() {
      const el = document.querySelector('${ref.replace(/'/g, "\\'")}');
      return el ? (el.innerText || el.textContent || '').trim() : '';
    })()`;
  } else {
    console.error(`不支持的属性: ${attribute}`);
    console.error('支持: text, url, title');
    process.exit(1);
  }

  try {
    const result = await httpPost(`/eval?target=${target.targetId || target.id}`, expression);
    if (result && result.value !== undefined) {
      console.log(typeof result.value === 'string' ? result.value : JSON.stringify(result.value));
    } else if (result && result.error) {
      console.error('执行错误:', result.error);
      process.exit(1);
    } else {
      console.log('');
    }
  } catch (e) {
    console.error('执行失败:', e.message);
    process.exit(1);
  }
}

/**
 * 导航命令
 */
async function navCommand(action) {
  const target = await getCurrentTarget();
  if (!target) {
    console.error('未找到活动的页面tab');
    process.exit(1);
  }

  const targetId = target.targetId || target.id;
  let path;
  
  if (action === 'back') {
    path = `/back?target=${targetId}`;
  } else if (action === 'forward') {
    // forward通过history.forward()实现
    await httpPost('/eval?target=' + targetId, 'history.forward(); "forward"');
    console.log('已前进');
    return;
  } else if (action === 'refresh') {
    // refresh通过navigate到当前URL实现
    const info = await httpGet(`/info?target=${targetId}`);
    const currentUrl = typeof info === 'string' ? JSON.parse(info).url : info?.url;
    if (currentUrl) {
      path = `/navigate?target=${targetId}&url=${encodeURIComponent(currentUrl)}`;
    } else {
      console.error('无法获取当前URL');
      process.exit(1);
    }
  } else {
    console.error(`不支持的导航动作: ${action}`);
    console.error('支持: back, forward, refresh');
    process.exit(1);
  }

  try {
    await httpGet(path);
    console.log(`已执行: ${action}`);
  } catch (e) {
    console.error('导航失败:', e.message);
    process.exit(1);
  }
}

/**
 * 网络请求查看
 * network requests [filter]
 */
async function networkCommand(args) {
  const subCommand = args[0] || 'requests';
  const filter = args[1];

  if (subCommand !== 'requests') {
    console.error(`不支持的network子命令: ${subCommand}`);
    console.error('支持: requests [filter]');
    process.exit(1);
  }

  const target = await getCurrentTarget();
  if (!target) {
    console.error('未找到活动的页面tab');
    process.exit(1);
  }

  const targetId = target.targetId || target.id;
  
  try {
    // 启用监控
    await httpGet(`/monitor/enable?target=${targetId}`);
    
    // 获取网络请求
    const filterParam = filter ? `&filter=${encodeURIComponent(filter)}` : '';
    const result = await httpGet(`/monitor/network?target=${targetId}${filterParam}`);
    
    if (result && result.requests && result.requests.length > 0) {
      console.log(`网络请求 (${result.requests.length}/${result.total}):`);
      console.log('─'.repeat(60));
      
      for (const req of result.requests.slice(-20)) { // 显示最近20个
        const status = req.status ? `[${req.status}]` : '[Pending]';
        const method = req.method.padEnd(6);
        const url = req.url.length > 80 ? req.url.substring(0, 77) + '...' : req.url;
        
        console.log(`${status} ${method} ${url}`);
        if (req.failed) {
          console.log(`  错误: ${req.failureReason}`);
        }
      }
      
      if (result.requests.length > 20) {
        console.log(`... 还有 ${result.requests.length - 20} 个请求`);
      }
    } else {
      console.log('暂无网络请求数据');
      console.log('提示: 页面加载时的请求可能已被记录，但新请求需要页面交互后才能捕获');
    }
  } catch (e) {
    console.error('获取网络请求失败:', e.message);
    process.exit(1);
  }
}

/**
 * 控制台查看/清空
 * console [--clear]
 */
async function consoleCommand(args) {
  const clear = args.includes('--clear');

  const target = await getCurrentTarget();
  if (!target) {
    console.error('未找到活动的页面tab');
    process.exit(1);
  }

  const targetId = target.targetId || target.id;

  try {
    if (clear) {
      await httpGet('/monitor/console/clear');
      console.log('控制台日志已清空');
    } else {
      // 启用监控
      await httpGet(`/monitor/enable?target=${targetId}`);
      
      // 获取控制台日志
      const result = await httpGet(`/monitor/console?target=${targetId}`);
      
      if (result && result.messages && result.messages.length > 0) {
        console.log(`控制台日志 (${result.messages.length}/${result.total}):`);
        console.log('─'.repeat(60));
        
        for (const msg of result.messages.slice(-20)) { // 显示最近20条
          const typeColors = {
            log: '\x1b[0m',      // 默认
            info: '\x1b[36m',    // 青色
            warn: '\x1b[33m',    // 黄色
            error: '\x1b[31m',   // 红色
            debug: '\x1b[90m'    // 灰色
          };
          const color = typeColors[msg.type] || typeColors.log;
          const reset = '\x1b[0m';
          
          console.log(`${color}[${msg.type}]${reset} ${msg.text}`);
          if (msg.url) {
            console.log(`  ${msg.url}:${msg.lineNumber || '?'}`);
          }
        }
        
        if (result.messages.length > 20) {
          console.log(`... 还有 ${result.messages.length - 20} 条日志`);
        }
      } else {
        console.log('暂无控制台日志');
      }
    }
  } catch (e) {
    console.error('控制台操作失败:', e.message);
    process.exit(1);
  }
}

/**
 * 错误查看/清空
 * errors [--clear]
 */
async function errorsCommand(args) {
  const clear = args.includes('--clear');

  const target = await getCurrentTarget();
  if (!target) {
    console.error('未找到活动的页面tab');
    process.exit(1);
  }

  const targetId = target.targetId || target.id;

  try {
    if (clear) {
      await httpGet('/monitor/errors/clear');
      console.log('JS错误日志已清空');
    } else {
      // 启用监控
      await httpGet(`/monitor/enable?target=${targetId}`);
      
      // 获取JS错误
      const result = await httpGet(`/monitor/errors?target=${targetId}`);
      
      if (result && result.errors && result.errors.length > 0) {
        console.log(`JS错误 (${result.errors.length}/${result.total}):`);
        console.log('─'.repeat(60));
        
        for (const err of result.errors.slice(-10)) { // 显示最近10个
          console.log(`\x1b[31m[ERROR]\x1b[0m ${err.message?.substring(0, 200) || 'Unknown error'}`);
          if (err.url) {
            console.log(`  at ${err.url}:${err.lineNumber}:${err.columnNumber}`);
          }
          if (err.stackTrace) {
            console.log(`  Stack trace:\n    ${err.stackTrace.split('\n').join('\n    ')}`);
          }
          console.log('');
        }
        
        if (result.errors.length > 10) {
          console.log(`... 还有 ${result.errors.length - 10} 个错误`);
        }
      } else {
        console.log('暂无JS错误');
      }
    }
  } catch (e) {
    console.error('错误日志操作失败:', e.message);
    process.exit(1);
  }
}

// --- 主函数 ---
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log(`
web-access browser-commands - 浏览器控制命令

用法:
  页面信息:
    get text <selector>   获取元素文本 (CSS选择器)
    get url               获取当前URL
    get title             获取页面标题

  导航:
    back                  后退
    forward               前进
    refresh               刷新

  调试:
    network requests      查看网络请求 (需要扩展)
    console [--clear]     查看/清空控制台 (需要扩展)
    errors [--clear]      查看/清空JS错误

示例:
  browser-commands.mjs get url
  browser-commands.mjs get title
  browser-commands.mjs get text "h1"
  browser-commands.mjs back
  browser-commands.mjs refresh
  browser-commands.mjs network requests
  browser-commands.mjs console
  browser-commands.mjs errors --clear
`);
    process.exit(0);
  }

  const command = args[0];
  const subArgs = args.slice(1);

  try {
    switch (command) {
      case 'get':
        await getCommand(subArgs);
        break;
      case 'back':
      case 'forward':
      case 'refresh':
        await navCommand(command);
        break;
      case 'network':
        await networkCommand(subArgs);
        break;
      case 'console':
        await consoleCommand(subArgs);
        break;
      case 'errors':
        await errorsCommand(subArgs);
        break;
      default:
        console.error(`未知命令: ${command}`);
        console.error('运行 browser-commands.mjs 查看帮助');
        process.exit(1);
    }
  } catch (e) {
    console.error('执行错误:', e.message);
    process.exit(1);
  }
}

main();