module.exports = {
  apps: [
    {
      name: "bot-barbearia",
      script: "index.js",

      // Reinicio automatico
      autorestart: true,
      watch: false,

      // Se travar e passar de 600MB de RAM, reinicia sozinho
      max_memory_restart: "600M",

      // Evita loop infinito de restart quando ha erro de configuracao
      min_uptime: "60s",
      max_restarts: 15,
      restart_delay: 5000,
      exp_backoff_restart_delay: 200,

      // Logs com data/hora, uteis para descobrir por que caiu
      time: true,
      log_date_format: "DD/MM/YYYY HH:mm:ss",
      error_file: "./logs/bot-erro.log",
      out_file: "./logs/bot-saida.log",
      merge_logs: true,

      env: {
        NODE_ENV: "production"
      }
    },
    {
      name: "ngrok-tunnel",
      script: ".\\ngrok.exe",
      args: "http 10000 --domain=overcensorious-bart-nonpacific.ngrok-free.dev",
      interpreter: "none",
      autorestart: true,
      restart_delay: 10000,
      min_uptime: "30s",
      max_restarts: 20,
      time: true,
      error_file: "./logs/ngrok-erro.log",
      out_file: "./logs/ngrok-saida.log"
    }
  ]
};
