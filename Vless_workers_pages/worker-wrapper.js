// _worker.js
addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  return new Response(`
    <!DOCTYPE html>
    <html>
      <body>
        <script src="/nat64套壳版混淆.js"></script>
      </body>
    </html>
  `, {
    headers: { 'Content-Type': 'text/html' }
  });
}
