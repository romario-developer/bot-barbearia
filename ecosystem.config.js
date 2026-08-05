module.exports = {
  apps: [
    {
      name: "bot-barbearia",
      script: "index.js"
    },
    {
      name: "ngrok-tunnel",
      script: ".\\ngrok.exe",
      args: "http 10000 --domain=overcensorious-bart-nonpacific.ngrok-free.dev",
      interpreter: "none"
    }
  ]
};