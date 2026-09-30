// Verification fixture: run only on localhost through verify-live.mjs.
export default {
 async fetch(request, env) {
  try {
   const path = new URL(request.url).pathname;
   if(path==='/health')return new Response('ready');
   if(path==='/capabilities')return Response.json(await env.MERMAID2.describeCapabilities());
   if(path.startsWith('/skills/'))return new Response(await env.MERMAID2.readSkill(path.split('/').pop()));
   if(path==='/vendor'){
    const vendor=await env.VENDOR.describe();
    const account=await env.VENDOR.createAccount();
    const resources=await account.getSupportedResources();
    const resourceClass=await account.getGatekeeperClassFor('mermaid2://renderer');
    const configurator=await account.startResourceConfigurator('mermaid2://renderer');
    return Response.json({vendor:vendor.displayName,autoProvisionsAccount:vendor.autoProvisionsAccount,resources,resourceClass:!!resourceClass.class,configurator:configurator.iframeHtml.includes('mermaid2://renderer')});
   }
   if(request.method!=='POST')return new Response('Not found',{status:404});
   const output=await env.MERMAID2.render(await request.json());
   return new Response(output.data,{headers:{'content-type':output.contentType,'x-filename':output.filename,'x-nodes':String(output.nodes),'x-edges':String(output.edges)}});
  } catch(error){return new Response(String(error.message),{status:422});}
 }
};
