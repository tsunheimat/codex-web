// Exact insertion points for the already-inspected 26.908.40834 bundle.
// The preparer verifies input hashes and every anchor's occurrence count.
const rendererCase =
  'case`codex_web_native_v1`:try{y=LW(await codexWebNativeRenderer(c.arguments,{target:id=>oJr(e,id,!0),upload:async file=>(await import("./chatgpt-file-upload-abd0e2109411.js")).uploadChatGptConversationFile(e,file,{storeInLibrary:!1}),prepare:p=>Iqr({...p,systemHints:e.get(bR,Xor(c.arguments.conversationId))}),submit:async p=>{const id=Xor(p.conversationId);if(e.get(xR,id)||e.get(JCr,id)||NP(e.get(mF,id)))throw Error("Native ChatGPT conversation is already responding");const model=e.get(xBr,id);e.set(xR,id,!0);try{await Rqr(e,{conversationId:id,prompt:p.prompt,attachments:p.attachments,userCompletionMessages:p.prepared.bundle,parentMessageId:p.prepared.parentMessageId,isTemporaryChat:!1,model:model.slug,thinkingEffort:model.thinkingEffort,systemHints:e.get(bR,id)});return{messageId:p.prepared.bundle.message.id}}finally{e.set(xR,id,!1)}}}));}catch(error){y=$C(error.message)}break;';
module.exports = {
  desktopVersion: "26.908.40834",
  files: {
    main: ".vite/build/main-D8abTQQE.js",
    renderer: "webview/assets/app-initial-d9bed9d614d8.js",
  },
  edits: [
    {
      file: "main",
      anchor: "",
      prepend:
        'const codexWebNative=require("./codex-web-native/entry.cjs");\n',
    },
    {
      file: "main",
      anchor: "let je=Ae.getWindowContext();",
      after:
        'codexWebNative.bindAppTools(l,params=>je.callDynamicAppTool({hostId:"local",params},new AbortController().signal));',
    },
    {
      file: "main",
      anchor: "Ee=Ge.hasActiveTurn",
      replacement: "(codexWebNative.bindComputerUse(Ge),Ee=Ge.hasActiveTurn)",
    },
    {
      file: "main",
      anchor:
        "let m=are(a.params),h=Ka(m.method,m.params,m.codexTurnMetadata);",
      after:
        "codexWebNative.observeOwner(c,m.codexTurnMetadata,response=>i.handleApprovalResponse(response),m.method);",
    },
    {
      file: "main",
      anchor: "createElicitation:e=>i.requestApprovalForSender(s,e)",
      replacement:
        "createElicitation:e=>codexWebNative.elicit(i,s,c,m.codexTurnMetadata,e)",
    },
    {
      file: "main",
      anchor: "n({id:o,jsonrpc:`2.0`,method:$ne,params:r})",
      replacement:
        "(codexWebNative.observeApproval(n,{id:o,jsonrpc:`2.0`,method:$ne,params:r},()=>t.has(o)),n({id:o,jsonrpc:`2.0`,method:$ne,params:r}))",
    },
    {
      file: "main",
      anchor: "handleApprovalResponse:n=>{",
      after: "codexWebNative.observeApprovalResponse(n);",
    },
    {
      file: "main",
      anchor: "p=`completed`,s({id:l,jsonrpc:`2.0`,result:g})",
      replacement:
        "codexWebNative.observeResult(c,m.codexTurnMetadata,m.method,g),p=`completed`,s({id:l,jsonrpc:`2.0`,result:g})",
    },
    {
      file: "main",
      anchor: "sendInlineMessageForView(e,t){",
      after: "codexWebNative.observePresentation(e,t);",
      count: 2,
    },
    {
      file: "renderer",
      anchor: "",
      prepend:
        'import {dispatchNativeRenderer as codexWebNativeRenderer} from "./codex-web-native-renderer.mjs";\n',
    },
    {
      file: "renderer",
      anchor: "case wj:y=await eTi(",
      replacement: rendererCase + "case wj:y=await eTi(",
    },
  ],
};
