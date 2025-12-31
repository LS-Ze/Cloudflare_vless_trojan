// worker-wrapper.js
export default {
  async fetch(request, env, ctx) {
    // 导入混淆的脚本
    await import('./nat64套壳版混淆.js');
    
    // 调用混淆脚本中的处理函数
    if (typeof handleRequest === 'function') {
      return handleRequest(request);
    }
    
    return new Response('Worker error', { status: 500 });
  }
};
