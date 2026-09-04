module.exports = {
  apps: [{
    name: "tracker420rh",
    script: "dist/index.js",
    cwd: __dirname,
    instances: 1,
    autorestart: true,
    watch: false,
    restart_delay: 5000,
    max_memory_restart: "400M",
    time: false,
    env: {
      NODE_ENV: "production",
    },
  }],
};