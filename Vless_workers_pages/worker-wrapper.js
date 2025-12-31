// _worker.js
addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  // 这里可以添加您的逻辑
  return new Response('Worker is running', { status: 200 });
}

// 加载混淆脚本
(async () => {
  try {
    // 使用fetch加载混淆脚本
    const response = await fetch('/nat64套壳版混淆.js');
    const script = await response.text();
    
    // 执行脚本
    eval(script);
    
    console.log('混淆脚本加载成功');
  } catch (error) {
    console.error('加载混淆脚本失败:', error);
  }
})();
