module.exports = {
  apps: [{
    name: "donkeyserver",
    script: "/Users/donkeyserver/nanoclaw/dist/index.js",
    instances: 1,
    exec_mode: "fork",
    autorestart: true,
    restart_delay: 5000,
    max_restarts: 10,
    max_memory_restart: "300M",
    watch: false,
    env: {
      NODE_ENV: "production",
      PORT: 3001
    }
  }]
}