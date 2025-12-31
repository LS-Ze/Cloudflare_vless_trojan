// worker-wrapper.js
// 导入混淆的Worker脚本
importScripts('nat64套壳版混淆.js');

// 简单的事件监听器
addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});
