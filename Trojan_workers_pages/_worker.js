// src/worker.js
import { connect } from "cloudflare:sockets";

/**
 * Cloudflare Proxy Worker
 * 安全优化版 - 修复了多个关键问题
 */

// 配置参数
const config = {
  password: "proxy",
  proxyIPs: [],
  cdnHosts: [],
  httpPorts: ['80', '8080', '8880', '2052', '2082', '2086', '2095'],
  httpsPorts: ['443', '8443', '2053', '2083', '2087', '2096'],
  wsPath: "/?ed=2560",
  keepaliveInterval: 30000, // 30秒心跳
  maxConnections: 100,      // 最大并发连接数
  connectionTimeout: 60000  // 连接超时时间
};

// 当前连接计数
let connectionCount = 0;

/**
 * 验证IP地址格式
 * @param {string} ip - IP地址
 * @returns {boolean} 是否为有效IP
 */
function isValidIP(ip) {
  if (!ip) return false;
  // IPv4 验证
  const ipv4Regex = /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
  // IPv6 验证 (简化版)
  const ipv6Regex = /^\[?([0-9a-fA-F:]+)\]?$/;
  
  return ipv4Regex.test(ip) || ipv6Regex.test(ip);
}

/**
 * 生成随机用户代理
 * @returns {string} 随机UA
 */
function getRandomUserAgent() {
  const uas = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1'
  ];
  return uas[Math.floor(Math.random() * uas.length)];
}

/**
 * WebSocket连接管理类
 */
class WebSocketManager {
  constructor(webSocket, log) {
    this.webSocket = webSocket;
    this.log = log;
    this.keepaliveTimer = null;
    this.isClosed = false;
    
    this.setupKeepalive();
    this.setupErrorHandling();
  }
  
  setupKeepalive() {
    this.keepaliveTimer = setInterval(() => {
      if (this.webSocket.readyState === WebSocket.OPEN) {
        try {
          this.webSocket.send(JSON.stringify({ type: 'ping' }));
        } catch (error) {
          this.log('Keepalive send error:', error);
          this.cleanup();
        }
      } else {
        this.cleanup();
      }
    }, config.keepaliveInterval);
  }
  
  setupErrorHandling() {
    this.webSocket.addEventListener('error', (error) => {
      this.log('WebSocket error:', error);
      this.cleanup();
    });
    
    this.webSocket.addEventListener('close', () => {
      this.log('WebSocket closed');
      this.cleanup();
    });
  }
  
  cleanup() {
    if (this.isClosed) return;
    
    this.isClosed = true;
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    
    try {
      if (this.webSocket.readyState === WebSocket.OPEN || 
          this.webSocket.readyState === WebSocket.CLOSING) {
        this.webSocket.close(1000, 'Cleanup');
      }
    } catch (error) {
      this.log('Cleanup error:', error);
    }
  }
}

/**
 * 解析代理头部
 * @param {ArrayBuffer} buffer - 数据缓冲区
 * @returns {object} 解析结果
 */
async function parseProxyHeader(buffer) {
  if (buffer.byteLength < 56) {
    return { hasError: true, message: "Invalid data length" };
  }
  
  const view = new DataView(buffer);
  const password = new TextDecoder().decode(buffer.slice(0, 56)).trim();
  
  if (password !== sha256.sha224(config.password)) {
    return { hasError: true, message: "Invalid password" };
  }
  
  const socks5Data = buffer.slice(58); // Skip CRLF
  if (socks5Data.byteLength < 6) {
    return { hasError: true, message: "Invalid SOCKS5 data" };
  }
  
  const cmd = view.getUint8(58);
  if (cmd !== 1) { // Only CONNECT is supported
    return { hasError: true, message: "Unsupported command" };
  }
  
  const atype = view.getUint8(59);
  let address = "";
  let addressLength = 0;
  let addressIndex = 60;
  
  switch (atype) {
    case 1: // IPv4
      addressLength = 4;
      address = new Uint8Array(socks5Data.slice(1, 5)).join(".");
      break;
    case 3: // Domain name
      addressLength = view.getUint8(60);
      addressIndex = 61;
      address = new TextDecoder().decode(socks5Data.slice(2, 2 + addressLength));
      break;
    case 4: // IPv6
      addressLength = 16;
      const ipv6Data = new DataView(socks5Data.slice(1, 17));
      const ipv6Parts = [];
      for (let i = 0; i < 8; i++) {
        ipv6Parts.push(ipv6Data.getUint16(i * 2).toString(16));
      }
      address = ipv6Parts.join(":");
      break;
    default:
      return { hasError: true, message: `Invalid address type: ${atype}` };
  }
  
  if (!address) {
    return { hasError: true, message: "Empty address" };
  }
  
  const portIndex = addressIndex + addressLength;
  const port = view.getUint16(portIndex);
  
  return {
    hasError: false,
    address,
    port,
    rawData: socks5Data.slice(portIndex + 2)
  };
}

/**
 * 处理TCP连接
 */
async function handleTCPConnection(webSocket, address, port, initialData, log) {
  let proxyIP = config.proxyIPs.length > 0 
    ? config.proxyIPs[Math.floor(Math.random() * config.proxyIPs.length)] 
    : address;
  
  let proxyPort = port;
  
  // 解析代理IP和端口
  if (proxyIP.includes(':')) {
    const parts = proxyIP.split(':');
    if (parts.length === 2) {
      [proxyIP, proxyPort] = parts;
    } else {
      proxyPort = '443';
    }
  } else {
    proxyPort = port || '443';
  }
  
  log(`Connecting to ${proxyIP}:${proxyPort}`);
  
  try {
    const socket = connect({
      hostname: proxyIP,
      port: proxyPort
    });
    
    // 发送初始数据
    const writer = socket.writable.getWriter();
    await writer.write(initialData);
    writer.releaseLock();
    
    // 管理WebSocket连接
    const wsManager = new WebSocketManager(webSocket, log);
    
    // 数据转发
    socket.readable.pipeTo(new WritableStream({
      write(chunk) {
        if (webSocket.readyState === WebSocket.OPEN) {
          webSocket.send(chunk);
        }
      },
      close() {
        log('Socket readable closed');
        wsManager.cleanup();
      },
      abort(reason) {
        log('Socket readable aborted:', reason);
        wsManager.cleanup();
      }
    })).catch(error => {
      log('Pipe error:', error);
      wsManager.cleanup();
    });
    
    // 监听连接关闭
    socket.closed.catch(error => {
      log('Socket closed with error:', error);
      wsManager.cleanup();
    });
    
    return socket;
    
  } catch (error) {
    log('Connection error:', error);
    webSocket.close(1011, 'Connection failed');
    throw error;
  }
}

/**
 * WebSocket代理处理
 */
async function handleProxyWebSocket(request) {
  const webSocketPair = new WebSocketPair();
  const [client, webSocket] = Object.values(webSocketPair);
  
  // 限制并发连接数
  if (connectionCount >= config.maxConnections) {
    webSocket.accept();
    webSocket.close(1008, 'Too many connections');
    return new Response(null, { status: 101, webSocket: client });
  }
  
  connectionCount++;
  webSocket.accept();
  
  const url = new URL(request.url);
  const log = (message) => console.log(`[${url.hostname}] ${message}`);
  
  // 清理函数
  const cleanup = () => {
    connectionCount = Math.max(0, connectionCount - 1);
    log(`Connection count: ${connectionCount}`);
  };
  
  // 处理路径中的代理IP
  if (url.pathname.includes('/proxyip=')) {
    const ipParam = url.pathname.split('=')[1];
    if (isValidIP(ipParam)) {
      config.proxyIPs = [ipParam];
      log(`Using custom proxy IP: ${ipParam}`);
    }
  }
  
  // 处理消息
  webSocket.addEventListener('message', async (event) => {
    try {
      const buffer = await event.data.arrayBuffer();
      const headerResult = await parseProxyHeader(buffer);
      
      if (headerResult.hasError) {
        log(`Header error: ${headerResult.message}`);
        webSocket.close(1002, headerResult.message);
        return;
      }
      
      log(`Proxy request: ${headerResult.address}:${headerResult.port}`);
      await handleTCPConnection(webSocket, headerResult.address, headerResult.port, 
                                headerResult.rawData, log);
      
    } catch (error) {
      log(`Message error: ${error.message}`);
      webSocket.close(1011, error.message);
    }
  });
  
  // 连接管理
  webSocket.addEventListener('close', () => {
    log('Client disconnected');
    cleanup();
  });
  
  webSocket.addEventListener('error', (error) => {
    log(`WebSocket error: ${error.message}`);
    cleanup();
  });
  
  return new Response(null, { status: 101, webSocket: client });
}

/**
 * 处理HTTP请求
 */
async function handleHttpRequest(request) {
  const url = new URL(request.url);
  const host = request.headers.get('Host') || url.hostname;
  
  // 配置页面
  if (url.pathname === `/${config.password}`) {
    return new Response(generateConfigPage(host), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }
  
  // 订阅链接
  if (url.pathname.startsWith(`/${config.password}/`)) {
    const type = url.pathname.split('/')[2];
    return generateSubscription(type, host);
  }
  
  // 健康检查
  if (url.pathname === '/health') {
    return new Response(JSON.stringify({
      status: 'ok',
      connections: connectionCount,
      timestamp: new Date().toISOString()
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // 默认响应
  return new Response('Not found', { status: 404 });
}

/**
 * 生成配置页面
 */
function generateConfigPage(host) {
  const wsUrl = `ws://${host}${config.wsPath}`;
  const wssUrl = `wss://${host}${config.wsPath}`;
  
  return `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8">
    <title>Proxy Configuration</title>
    <style>
      body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
      .config-box { background: #f5f5f5; padding: 15px; margin: 10px 0; border-radius: 5px; }
      .btn { background: #4CAF50; color: white; padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer; }
      .btn:hover { background: #45a049; }
    </style>
  </head>
  <body>
    <h1>Proxy Configuration</h1>
    <p>Current connections: ${connectionCount}</p>
    
    <div class="config-box">
      <h3>WebSocket Configuration</h3>
      <p>Password: <code>${config.password}</code></p>
      <p>WS URL: <code>${wsUrl}</code></p>
      <p>WSS URL: <code>${wssUrl}</code></p>
    </div>
    
    <div class="config-box">
      <h3>HTTP Ports</h3>
      <p>${config.httpPorts.join(', ')}</p>
    </div>
    
    <div class="config-box">
      <h3>HTTPS Ports</h3>
      <p>${config.httpsPorts.join(', ')}</p>
    </div>
    
    <button class="btn" onclick="window.location.reload()">Refresh</button>
  </body>
  </html>
  `;
}

/**
 * 生成订阅链接
 */
function generateSubscription(type, host) {
  // 实现订阅生成逻辑
  return new Response('Subscription not implemented yet', {
    headers: { 'Content-Type': 'text/plain' }
  });
}

/**
 * 主请求处理函数
 */
export default {
  async fetch(request, env, ctx) {
    try {
      // 更新配置从环境变量
      if (env.PASSWORD) config.password = env.PASSWORD;
      if (env.PROXY_IPS) config.proxyIPs = env.PROXY_IPS.split(',');
      if (env.CDN_HOSTS) config.cdnHosts = env.CDN_HOSTS.split(',');
      
      const upgradeHeader = request.headers.get('Upgrade');
      
      // WebSocket请求
      if (upgradeHeader === 'websocket') {
        return handleProxyWebSocket(request);
      }
      
      // HTTP请求
      return handleHttpRequest(request);
      
    } catch (error) {
      console.error('Main error:', error);
      return new Response(`Error: ${error.message}`, { status: 500 });
    }
  }
};

/**
 * SHA-256 哈希库
 * 简化版，仅保留必要功能
 */
const sha256 = (function() {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  function sha224(message) {
    const H = [
      0xc1059ed8, 0x367cd507, 0x3070dd17, 0xf70e5939,
      0xffc00b31, 0x68581511, 0x64f98fa7, 0xbefa4fa4
    ];
    return hash(message, H, true);
  }

  function hash(message, H, is224) {
    const blocks = [];
    let i = 0, len = message.length;
    
    // 转换消息
    for (; i < len; i++) {
      const code = message.charCodeAt(i);
      if (code < 0x80) {
        blocks.push(code);
      } else if (code < 0x800) {
        blocks.push(0xc0 | (code >>> 6));
        blocks.push(0x80 | (code & 0x3f));
      } else {
        blocks.push(0xe0 | (code >>> 12));
        blocks.push(0x80 | ((code >>> 6) & 0x3f));
        blocks.push(0x80 | (code & 0x3f));
      }
    }
    
    // 添加结束标志
    blocks.push(0x80);
    
    // 填充长度
    const bitLength = len * 8;
    while ((blocks.length * 8) % 512 !== 448) {
      blocks.push(0x00);
    }
    
    for (i = 7; i >= 0; i--) {
      blocks.push((bitLength >>> (i * 8)) & 0xff);
    }
    
    // 处理每个块
    for (i = 0; i < blocks.length; i += 64) {
      const w = new Array(64);
      for (let j = 0; j < 16; j++) {
        w[j] = (blocks[i + j * 4] << 24) | (blocks[i + j * 4 + 1] << 16) |
               (blocks[i + j * 4 + 2] << 8) | blocks[i + j * 4 + 3];
      }
      
      for (let j = 16; j < 64; j++) {
        const s0 = ((w[j - 15] >>> 7) | (w[j - 15] << 25)) ^
                   ((w[j - 15] >>> 18) | (w[j - 15] << 14)) ^
                   (w[j - 15] >>> 3);
        const s1 = ((w[j - 2] >>> 17) | (w[j - 2] << 15)) ^
                   ((w[j - 2] >>> 19) | (w[j - 2] << 13)) ^
                   (w[j - 2] >>> 10);
        w[j] = (w[j - 16] + s0 + w[j - 7] + s1) >>> 0;
      }
      
      let a = H[0], b = H[1], c = H[2], d = H[3];
      let e = H[4], f = H[5], g = H[6], h = H[7];
      
      for (let j = 0; j < 64; j++) {
        const S1 = ((e >>> 6) | (e << 26)) ^
                   ((e >>> 11) | (e << 21)) ^
                   ((e >>> 25) | (e << 7));
        const ch = (e & f) ^ (~e & g);
        const temp1 = (h + S1 + ch + K[j] + w[j]) >>> 0;
        const S0 = ((a >>> 2) | (a << 30)) ^
                   ((a >>> 13) | (a << 19)) ^
                   ((a >>> 22) | (a << 10));
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const temp2 = (S0 + maj) >>> 0;
        
        h = g; g = f; f = e; e = (d + temp1) >>> 0;
        d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
      }
      
      H[0] = (H[0] + a) >>> 0;
      H[1] = (H[1] + b) >>> 0;
      H[2] = (H[2] + c) >>> 0;
      H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0;
      H[5] = (H[5] + f) >>> 0;
      H[6] = (H[6] + g) >>> 0;
      H[7] = (H[7] + h) >>> 0;
    }
    
    // 转换为十六进制
    let hex = '';
    for (i = 0; i < (is224 ? 7 : 8); i++) {
      hex += ((H[i] >>> 24) & 0xff).toString(16).padStart(2, '0');
      hex += ((H[i] >>> 16) & 0xff).toString(16).padStart(2, '0');
      hex += ((H[i] >>> 8) & 0xff).toString(16).padStart(2, '0');
      hex += (H[i] & 0xff).toString(16).padStart(2, '0');
    }
    
    return hex;
  }

  return { sha224 };
})();
