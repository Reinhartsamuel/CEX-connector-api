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

  ]
};
