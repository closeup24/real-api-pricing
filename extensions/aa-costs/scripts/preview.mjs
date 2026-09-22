import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const report = fileURLToPath(new URL('../output/report.html', import.meta.url));
const port = Number(process.env.AI_PRICE_PORT || 8765);
const server = createServer(async (request, response) => {
  if (request.url !== '/' && request.url !== '/report.html') {
    response.writeHead(404).end('Не найдено');
    return;
  }
  try {
    const content = await readFile(report);
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(content);
  } catch {
    response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Сначала выполните npm run build.');
  }
});
server.listen(port, '127.0.0.1', () => console.log(`Отчёт: http://127.0.0.1:${port}`));
