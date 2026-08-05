const fs = require('fs');
const path = require('path');

// ==========================================
// LOCALIZA O NGROK
//
// O caminho muda de máquina para máquina, então procuramos nos lugares mais
// comuns. Se não encontrar, o túnel simplesmente não é iniciado e o bot roda
// normalmente (só o painel externo fica indisponível).
//
// Para apontar manualmente, defina a variável NGROK_PATH antes de subir:
//     $env:NGROK_PATH="C:\\caminho\\para\\ngrok.exe"
// ==========================================
const CAMINHOS_NGROK = [
    process.env.NGROK_PATH,
    path.join(__dirname, 'ngrok.exe'),
    path.join(__dirname, '..', 'ngrok.exe'),
    'C:\\ngrok\\ngrok.exe',
    'C:\\Program Files\\ngrok\\ngrok.exe',
    path.join(process.env.USERPROFILE || '', 'ngrok.exe'),
    path.join(process.env.USERPROFILE || '', 'Downloads', 'ngrok.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'ngrok', 'ngrok.exe')
].filter(Boolean);

const ngrokEncontrado = CAMINHOS_NGROK.find(c => {
    try { return fs.existsSync(c); } catch { return false; }
});

// A flag --domain foi descontinuada pelo ngrok; agora usa-se --url com a URL completa
const DOMINIO_NGROK = (process.env.NGROK_DOMINIO || 'overcensorious-bart-nonpacific.ngrok-free.dev')
    .replace(/^https?:\/\//, '');
const URL_NGROK = `https://${DOMINIO_NGROK}`;

const apps = [
    {
        name: 'bot-barbearia',
        script: 'index.js',
        cwd: __dirname,

        autorestart: true,
        watch: false,

        // Se travar e passar de 600MB de RAM, reinicia sozinho
        max_memory_restart: '600M',

        // Evita loop infinito de restart quando há erro de configuração
        min_uptime: '60s',
        max_restarts: 15,
        restart_delay: 5000,
        exp_backoff_restart_delay: 200,

        time: true,
        log_date_format: 'DD/MM/YYYY HH:mm:ss',
        error_file: path.join(__dirname, 'logs', 'bot-erro.log'),
        out_file: path.join(__dirname, 'logs', 'bot-saida.log'),
        merge_logs: true,

        env: { NODE_ENV: 'production' }
    }
];

if (ngrokEncontrado) {
    apps.push({
        name: 'ngrok-tunnel',
        script: ngrokEncontrado,
        args: `http 10000 --url=${URL_NGROK}`,
        interpreter: 'none',
        cwd: __dirname,

        autorestart: true,
        // Espera maior: se outro túnel ainda estiver liberando o domínio,
        // reiniciar rápido demais só gera erro em loop (ERR_NGROK_334)
        restart_delay: 20000,
        min_uptime: '30s',
        max_restarts: 10,

        time: true,
        error_file: path.join(__dirname, 'logs', 'ngrok-erro.log'),
        out_file: path.join(__dirname, 'logs', 'ngrok-saida.log')
    });
} else {
    console.log('[ecosystem] ngrok.exe não encontrado — o túnel não será iniciado.');
    console.log('[ecosystem] Para habilitar: $env:NGROK_PATH="caminho\\completo\\ngrok.exe"');
}

module.exports = { apps };
