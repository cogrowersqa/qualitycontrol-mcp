module.exports = {
  apps: [
    {
      name: "qualitycontrol-mcp",
      script: "dist/server.js",
      cwd: "/opt/bitnami/apache2/htdocs/mcp/qualitycontrol",
      instances: 1,
      exec_mode: "fork",
      node_args: "--experimental-vm-modules",
      env: {
        NODE_ENV: "production",
        MCP_PORT: 3100,
        MCP_HOST: "0.0.0.0",
      },
      env_file: ".env",
      watch: false,
      max_memory_restart: "256M",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      error_file: "./logs/pm2-error.log",
      out_file: "./logs/pm2-out.log",
      merge_logs: true,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
    },
  ],
};
