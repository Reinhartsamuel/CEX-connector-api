module.exports = {
  apps: [
    {
      name: "hono-api",
      script: "src/index.ts",
      interpreter: "bun",
      instances: 2,
      exec_mode: "cluster",
      env: { 
        NODE_ENV: "production", 
        REDIS_URL: process.env.REDIS_URL || "redis://127.0.0.1:6379"
      }
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