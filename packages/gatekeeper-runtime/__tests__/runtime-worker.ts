// Local Docker smoke-test ingress only. Never used by the production Wrangler config.
export { PythonSandbox, RuntimeSession } from '../src/runner.js';
export default {
  async fetch(request:Request,env:Cloudflare.Env):Promise<Response> {
    const url=new URL(request.url);
    if(url.pathname==='/health')return new Response('ok');
    const session=env.SESSIONS.getByName(url.searchParams.get('session') ?? 'smoke');
    try {
      if(request.method==='POST'){
        const intent = await request.json();
        if (url.pathname === '/reject') await session.reject(intent); else await session.submit(intent);
        return Response.json({ok:true});
      }
      if(url.pathname==='/run') return Response.json(await session.getRun(url.searchParams.get('id') ?? ''));
      return Response.json(await session.getState());
    } catch(error) { return Response.json({error:String(error)},{status:400}); }
  },
};
