// Wrapper: sobe um túnel público (localtunnel) e em seguida o server.js
// com PUBLIC_URL apontando para o túnel — assim o QR fica acessível em
// qualquer rede (4G/5G dos celulares do público).
const { spawn } = require('child_process');
const localtunnel = require('localtunnel');

const PORT = parseInt(process.env.PORT || '3000', 10);

(async () => {
  console.log('🌐 Abrindo túnel público (localtunnel)…');
  let tunnel;
  try {
    tunnel = await localtunnel({ port: PORT });
  } catch (err) {
    console.error('❌ Falha ao abrir túnel:', err.message);
    console.error('   Caindo para modo local (mesma Wi-Fi). Rode `npm start`.');
    process.exit(1);
  }

  console.log('🌐 URL pública: ' + tunnel.url);
  console.log('   (compartilhe com o público; funciona em qualquer rede)\n');

  const srv = spawn(process.execPath, ['server.js'], {
    stdio: 'inherit',
    env: { ...process.env, PUBLIC_URL: tunnel.url, PORT: String(PORT) },
  });

  const cleanup = () => { try { tunnel.close(); } catch {} try { srv.kill(); } catch {} };
  srv.on('exit', code => { cleanup(); process.exit(code || 0); });
  tunnel.on('close', () => { srv.kill(); });
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
})();
