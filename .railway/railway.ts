import { defineRailway, github, postgres, project, service } from 'railway/iac';

export default defineRailway(() => {
  const database = postgres('postgres');
  const web = service('shlab', {
    source: github('matheuscoutinhoo/shNet', { branch: 'main', rootDirectory: '/' }),
    build: { builder: 'DOCKERFILE', dockerfilePath: 'Dockerfile' },
    start: 'node --import tsx apps/api/src/main.ts',
    preDeploy: 'node --import tsx apps/api/src/migrate.ts',
    healthcheck: '/api/health',
    healthcheckTimeout: 120,
    replicas: 1,
    deploy: { restartPolicyType: 'ON_FAILURE', restartPolicyMaxRetries: 3, drainingSeconds: 30 },
    env: {
      NODE_ENV: 'production',
      DATABASE_MODE: 'server',
      DATABASE_URL: database.env.DATABASE_URL,
      HOST: '::',
      PORT: '8080',
      MAIL_PROVIDER: 'none',
    },
  });
  return project('shLab', { resources: [web, database] });
});
