module.exports = {
  apps: [
    {
      name: "api",
      script: "src/index.ts",
      interpreter: "bun",
      cwd: "/home/ec2-user/CEX-connector-api",
      env_file: "/home/ec2-user/CEX-connector-api/.env",
      autorestart: true,
      max_restarts: 5,
      watch: false,
    },
    {
      name: "gate-worker",
      script: "src/workers/gateWorkerRunner.ts",
      interpreter: "bun",
      instances: 2,
      exec_mode: "fork",
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
        REDIS_URL: process.env.REDIS_URL || "redis://127.0.0.1:6379"
      }
    }
  ]
};
