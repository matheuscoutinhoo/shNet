// Test only: built production assets and a disposable in-memory database.
// No source watching/HMR and no access to the user's PostgreSQL data directory.
import {preview} from 'vite';
import {createEmbedded,migrate} from '../../apps/api/src/db';
import {buildApp} from '../../apps/api/src/app';
import {createMailer} from '../../apps/api/src/mailer';
const db=await createEmbedded();await migrate(db);
const api=await buildApp({db,mailer:createMailer({MAIL_PROVIDER:'local'}),origin:'http://127.0.0.1:5194'});
await api.listen({host:'127.0.0.1',port:3094});
const web=await preview({root:'apps/web',configFile:'apps/web/vite.config.ts',preview:{host:'127.0.0.1',port:5194,strictPort:true,proxy:{'/api':{target:'http://127.0.0.1:3094',ws:true}}}});
const close=async()=>{web.httpServer.close();await api.close();await db.close();process.exit(0);};
process.on('SIGTERM',close);process.on('SIGINT',close);
