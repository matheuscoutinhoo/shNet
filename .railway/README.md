# Railway infrastructure

The project configuration is railway.ts, evaluated by the official Railway IaC SDK. It targets the GitHub repository https://github.com/matheuscoutinhoo/shNet on main, with one web service and private PostgreSQL.

Read [the deployment guide](../docs/railway.md) before planning or applying. Secrets belong in Railway shared/sealed variables, not in this directory. The file is not automatically applied by a GitHub application deployment.

```sh
railway login
railway link
railway config plan
```

Only apply an explicitly reviewed plan to the intended project and environment. This is a whole-project definition; never apply it to an unrelated project or approve unexpected deletions. No cloud resources or deployment are created by the local unit tests.
