"use strict";

/* Future Experience V3 使用独立模拟状态，不改变主演示的 net / topo / qod。 */
const FUTURE_NETWORK_PROFILES = {
  good: {
    name:"优秀", response:82, geometry:96, delay:0, step:1, maxAngle:180,
    title:"视角连续跟随", copy:"拖动视角后，当前视口快速响应，空间画面保持完整清晰。",
    stage:"视角连续 · 高清", uplink:"动态负载", viewport:"CLEAR", kind:""
  },
  latency: {
    name:"高时延", response:780, geometry:95, delay:650, step:1, maxAngle:180,
    title:"视角跟随出现滞后", copy:"控制请求仍可到达，但画面在拖动后延迟跟随，交互感明显下降。",
    stage:"视口请求等待", uplink:"路径时延高", viewport:"LAGGING", kind:"warn"
  },
  congested: {
    name:"拥塞", response:226, geometry:64, delay:180, step:5, maxAngle:180,
    title:"当前视口细节丢失", copy:"并发上行争抢资源，画面模糊、空间完整度下降，视角更新变得粗糙。",
    stage:"细节丢失 · 降级", uplink:"资源竞争", viewport:"DEGRADED", kind:"bad"
  },
  weak: {
    name:"弱覆盖", response:420, geometry:51, delay:260, step:5, maxAngle:25,
    title:"可探索范围被压缩", copy:"链路预算不足时，仅保留人物正面±25°视角和核心音频，环绕观察范围受限。",
    stage:"中心视角 · 受限", uplink:"覆盖不足", viewport:"LIMITED", kind:"bad"
  }
};

const futureEls = {
  shell:$("futureShell"), dialog:$("futureDialog"), production:$("futureProduction"), audience:$("futureAudience"),
  programSlot:$("futureProgramSlot"), viewerSlot:$("futureViewerSlot"), media:$("futureOrbitMedia"),
  video:$("futureOrbitVideo"), audio:$("futureCoreAudio"), angle:$("futureAngle"), preview:$("futurePreviewTrack"), layer3d:$("future3DLayer")
};
let futureSeekTimer=0, futurePreviewFrame=0, futurePreviewPending=0, futurePitch=0;
let futureDragging=false, futureDragStartX=0, futureDragStartAngle=0, future3d=null;
let futureSuspendedDemoMedia=[];

function suspendDemoMedia(){
  // 取消可能仍在等待 seek/loadeddata 的主演示同步任务，避免慢机器上旧任务稍后重新 play()。
  mediaTransitionEpoch++;
  document.body.classList.remove("media-syncing");
  futureSuspendedDemoMedia=[...document.querySelectorAll("#mv video")].map(video=>({video,resume:!video.paused}));
  futureSuspendedDemoMedia.forEach(({video})=>video.pause());
}

function resumeDemoMedia(){
  const suspended=futureSuspendedDemoMedia;
  futureSuspendedDemoMedia=[];
  suspended.forEach(({video,resume})=>{
    if(resume&&video.isConnected)video.play().catch(()=>{});
  });
}

function renderFutureMediaMode(){
  const show3d=futureMode==="viewer";
  futureEls.media.classList.toggle("show-viewer-3d",show3d);
  futureEls.media.classList.toggle("show-production-output",!show3d);
  futureEls.layer3d.setAttribute("aria-hidden",String(!show3d));
}

function ensureFuture3D(){
  if(future3d||!futureEls.layer3d)return;
  if(!window.OneLiveSpatial3D){
    futureEls.layer3d.classList.remove("is-loading");futureEls.layer3d.classList.add("is-error");
    $("future3DLoadingText").textContent="3D渲染组件不可用";
    $("futureEnterViewer").textContent="3D不可用";$("futureEnterViewer").setAttribute("aria-busy","false");
    return;
  }
  try{
    future3d=window.OneLiveSpatial3D.create(futureEls.layer3d,{
      onProgress:percent=>{
        $("future3DProgress").style.width=`${percent}%`;$("future3DLoadingText").textContent=`正在载入自然站姿 3D 人物 · ${percent}%`;
        $("futureEnterViewer").textContent=`3D准备中 ${percent}%`;$("futureEnterViewer").setAttribute("aria-busy","true");
      },
      onReady:details=>{
        future3dReady=true;futureEls.media.classList.add("has-3d");
        $("future3DLoadingText").textContent="HY-3D 3.1 人物已就绪";
        $("future3DHint").textContent="拖动环绕 · 人物与场景共享坐标";
        $("futureEnterViewer").textContent="进入3D空间";$("futureEnterViewer").setAttribute("aria-busy","false");
        future3d.setMode(futureMode);future3d.setNetwork(futureNetwork,futureQod);future3d.setAngle(0,true);renderFutureMediaMode();renderFutureAngle();
      },
      onError:()=>{
        future3dReady=false;renderFutureMediaMode();$("future3DLoadingText").textContent="3D人物加载失败，请返回后重试";
        $("futureEnterViewer").textContent="3D加载失败";$("futureEnterViewer").setAttribute("aria-busy","false");
      },
      onAngleRequest:angle=>{if(futureMode==="viewer")requestFutureAngle(angle);},
      onPitchRequest:pitch=>{futurePitch=Math.round(Number(pitch)||0);renderFutureSpatialAngles();}
    });
    future3d.setActive(futureOpen&&futureMode==="viewer");future3d.setMode(futureMode);future3d.setNetwork(futureNetwork,futureQod);
  }catch(error){
    futureEls.layer3d.classList.remove("is-loading");futureEls.layer3d.classList.add("is-error");
    $("future3DLoadingText").textContent="当前设备不支持3D渲染";
    $("futureEnterViewer").textContent="3D不可用";$("futureEnterViewer").setAttribute("aria-busy","false");
  }
}

function futurePolicy(){
  const base=FUTURE_NETWORK_PROFILES[futureNetwork]||FUTURE_NETWORK_PROFILES.good;
  if(!futureQod) return base;
  if(futureNetwork==="congested") return {...base,response:112,geometry:91,delay:80,step:1,title:"当前视口获得优先保障",copy:"QoD优先保障正在观看的视口、核心音频和控制流；非当前区域仍保持降级。",stage:"当前视口优先 · 清晰",viewport:"PRIORITY"};
  if(futureNetwork==="weak") return {...base,response:250,geometry:72,delay:140,step:2,title:"中心视口优先保障",copy:"QoD改善当前视口与核心音频，但弱覆盖下仍不能扩展到±25°完整范围。",stage:"中心视口优先 · 受限",viewport:"PRIORITY"};
  if(futureNetwork==="latency") return {...base,response:720,delay:600,title:"基础路径时延仍存在",copy:"QoD减少排队并优先控制流，但不会消除云端处理和传播形成的基础路径时延。",viewport:"PRIORITY"};
  return {...base,title:"当前视口已在保障范围",copy:"当前链路资源充足，开启QoD不会凭空增加频谱，体验保持稳定。",viewport:"PRIORITY"};
}

function futureAngleLabel(value){
  const n=Math.round(Number(value)||0);
  if(n===0) return "0°";
  return `${n>0?"+":"−"}${Math.abs(n)}°`;
}

function renderFutureSpatialAngles(){
  $("futureViewerAngleValue").textContent=`方位 ${futureAngleLabel(futureAngle)} / 俯仰 ${futureAngleLabel(futurePitch)}`;
}

function renderFutureAngle(){
  const label=futureAngleLabel(futureAngle), requested=futureAngleLabel(futureRequestedAngle);
  $("futurePreviewAngleValue").textContent=label;
  $("futureRailAngle").textContent=label;
  renderFutureSpatialAngles();
  $("futureAngleValue").textContent=requested;
  $("futurePreviewTrack").style.setProperty("--progress",`${((clamp(futureAngle,-25,25)+25)/50)*100}%`);
  futureEls.preview.value=String(clamp(futureAngle,-25,25));
  if(!futureDragging) futureEls.angle.value=String(futureRequestedAngle);
  if(future3d)future3d.setAngle(futureAngle);
}

function applyFutureAngle(value){
  const policy=futurePolicy(), limited=clamp(Math.round(Number(value)||0),-policy.maxAngle,policy.maxAngle);
  const stepped=Math.round(limited/policy.step)*policy.step;
  futureAngle=clamp(stepped,-policy.maxAngle,policy.maxAngle);
  const video=futureEls.video;
  if(Number.isFinite(video.duration)&&video.duration>0){
    const usable=Math.max(.01,video.duration-.05);
    video.pause();
    const target=((clamp(futureAngle,-25,25)+25)/50)*usable;
    if(Math.abs(video.currentTime-target)>.012)video.currentTime=target;
  }
  renderFutureAngle();
  if(futureMode==="viewer"){
    $("futureViewerTitle").textContent=policy.title;
    $("futureViewerCopy").textContent=policy.copy;
  }
}

function requestFutureAngle(value){
  const policy=futurePolicy();
  futureRequestedAngle=clamp(Math.round(Number(value)||0),-policy.maxAngle,policy.maxAngle);
  futureEls.angle.value=String(futureRequestedAngle);
  $("futureAngleValue").textContent=futureAngleLabel(futureRequestedAngle);
  clearTimeout(futureSeekTimer);
  if(policy.delay>0){
    $("futureViewerTitle").textContent=futureNetwork==="latency"?"视口请求等待中":"正在更新当前视口";
    $("futureViewerCopy").textContent=`已请求 ${futureAngleLabel(futureRequestedAngle)}，画面将在约 ${policy.delay}ms 后跟随。`;
    futureSeekTimer=setTimeout(()=>applyFutureAngle(futureRequestedAngle),policy.delay);
  }else applyFutureAngle(futureRequestedAngle);
}

function renderFutureNetwork(){
  const p=futurePolicy(), base=FUTURE_NETWORK_PROFILES[futureNetwork]||FUTURE_NETWORK_PROFILES.good;
  [$("futureStage"),futureEls.audience].forEach(element=>{
    element.className=element===futureEls.audience?"future-audience":"future-stage";
    element.classList.add(`future-net-${futureNetwork}`);
    if(futureQod) element.classList.add("future-qod");
  });
  document.querySelectorAll("[data-future-net]").forEach(button=>button.setAttribute("aria-pressed",String(button.dataset.futureNet===futureNetwork)));
  document.querySelectorAll("[data-future-qod]").forEach(button=>button.setAttribute("aria-pressed",String(futureQod)));
  $("futureHeadNetwork").textContent=base.name;
  $("futureResponseMetric").innerHTML=`${p.response}<small>ms</small>`;
  $("futureGeometryMetric").innerHTML=`${p.geometry}<small>%</small>`;
  $("futureNetworkResult").className=`future-network-result ${futureQod?"":base.kind}`;
  $("futureResultTitle").textContent=p.title; $("futureResultCopy").textContent=p.copy;
  $("futureStageStatus").textContent=p.stage; $("futureUplinkState").textContent=base.uplink; $("futureViewportState").textContent=p.viewport;
  $("futureViewerTitle").textContent=p.title; $("futureViewerCopy").textContent=p.copy;
  futureEls.angle.min=String(-p.maxAngle); futureEls.angle.max=String(p.maxAngle); futureEls.angle.step="1";
  futureRequestedAngle=clamp(futureRequestedAngle,-p.maxAngle,p.maxAngle);
  futureAngle=clamp(futureAngle,-p.maxAngle,p.maxAngle);
  applyFutureAngle(futureAngle);
  if(future3d)future3d.setNetwork(futureNetwork,futureQod);
  if(futureOpen&&futureMode==="production") playFutureProduction(false);
}

function futureMediaReady(){
  futureOrbitDuration=Number.isFinite(futureEls.video.duration)?futureEls.video.duration:0;
  futureEls.media.classList.remove("is-loading","is-error");futureEls.media.classList.add("is-ready");
  $("futureMediaState").textContent="可交互环绕视口已就绪";
}
function futureMediaFailed(){
  futureEls.media.classList.remove("is-loading","is-ready");futureEls.media.classList.add("is-error");
  $("futureMediaState").textContent="视频未加载，使用中间帧预演";
}
function prepareFutureMedia(){
  const video=futureEls.video;
  if(video.dataset.bufferRequested==="true")return;
  video.dataset.bufferRequested="true";
  video.preload="auto";
  video.load();
}
function moveFutureMedia(slot){ if(futureEls.media.parentElement!==slot) slot.appendChild(futureEls.media); }
function playFutureProduction(reset=false){
  const video=futureEls.video; video.muted=true;video.loop=false;video.pause();
  renderFutureMediaMode();
  if(reset&&Number.isFinite(video.duration)&&video.duration>0){
    futureRequestedAngle=futureAngle=0;
    video.currentTime=Math.max(.01,video.duration-.05)*.5;
    renderFutureAngle();
  }
  if(video.readyState<2)futureEls.media.classList.add("is-loading");
}

function setFutureSiblingsInert(inert){
  [...futureEls.shell.parentElement.children].forEach(element=>{if(element!==futureEls.shell)element.inert=inert;});
}
function trapFutureFocus(event){
  if(event.key!=="Tab")return;
  const focusable=[...futureEls.dialog.querySelectorAll("button,input")].filter(element=>!element.disabled&&!element.hidden&&element.offsetParent!==null);
  if(!focusable.length)return;const first=focusable[0],last=focusable[focusable.length-1];
  if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
  else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
}

function openFuture(){
  if(futureOpen)return;
  futureOpen=true;futureMode="production";futureReturnFocus=document.activeElement;
  suspendDemoMedia();
  prepareFutureMedia();
  $("evidence").hidden=true;$("evToggle").setAttribute("aria-expanded","false");
  futureEls.production.hidden=false;futureEls.audience.hidden=true;moveFutureMedia(futureEls.programSlot);
  renderFutureMediaMode();
  futureEls.shell.hidden=false;document.body.classList.add("future-open");setFutureSiblingsInert(true);
  renderFutureNetwork();futureRequestedAngle=futureAngle=0;renderFutureAngle();
  requestAnimationFrame(()=>futureEls.shell.classList.add("open"));
  ensureFuture3D();if(future3d){future3d.setActive(false);future3d.setMode("production");}
  playFutureProduction(true);setTimeout(()=>$("futureClose").focus(),40);
}
function closeFuture(){
  if(!futureOpen)return;
  futureOpen=false;futureMode="production";clearTimeout(futureSeekTimer);futureEls.video.pause();futureEls.audio.pause();
  if(future3d){future3d.setActive(false);future3d.setMode("production");}
  $("futureAudioControl").setAttribute("aria-pressed","false");$("futureAudioControl").querySelector("span").textContent="播放独立音频";
  moveFutureMedia(futureEls.programSlot);futureEls.production.hidden=false;futureEls.audience.hidden=true;
  futureEls.shell.classList.remove("open");document.body.classList.remove("future-open");setFutureSiblingsInert(false);
  setTimeout(()=>{if(!futureOpen)futureEls.shell.hidden=true;},190);
  resumeDemoMedia();
  const target=futureReturnFocus;futureReturnFocus=null;if(target&&typeof target.focus==="function")setTimeout(()=>target.focus(),0);
}
function enterFutureViewer(){
  if(!futureOpen||futureMode==="viewer")return;
  futureMode="viewer";futureEls.production.hidden=true;futureEls.audience.hidden=false;moveFutureMedia(futureEls.viewerSlot);
  futureEls.video.loop=false;futureEls.video.pause();futureRequestedAngle=futureAngle=0;renderFutureNetwork();applyFutureAngle(0);
  renderFutureMediaMode();
  futurePitch=0;
  if(future3d){future3d.setActive(true);future3d.setMode("viewer");future3d.setAngle(0,true);future3d.setPitch(0,true);}
  setTimeout(()=>$("futureViewerBack").focus(),20);
}
function exitFutureViewer(){
  if(futureMode!=="viewer")return;
  futureMode="production";clearTimeout(futureSeekTimer);futureEls.audio.pause();
  $("futureAudioControl").setAttribute("aria-pressed","false");$("futureAudioControl").querySelector("span").textContent="播放独立音频";
  moveFutureMedia(futureEls.programSlot);futureEls.audience.hidden=true;futureEls.production.hidden=false;
  futureRequestedAngle=futureAngle=0;renderFutureNetwork();renderFutureAngle();playFutureProduction(true);
  renderFutureMediaMode();if(future3d){future3d.setActive(false);future3d.setMode("production");}
  setTimeout(()=>$("futureEnterViewer").focus(),20);
}
function toggleFutureAudio(){
  const button=$("futureAudioControl"),audio=futureEls.audio;
  if(audio.paused){audio.play().then(()=>{button.setAttribute("aria-pressed","true");button.querySelector("span").textContent="独立音频播放中";}).catch(()=>{button.querySelector("span").textContent="音频播放失败";});}
  else{audio.pause();button.setAttribute("aria-pressed","false");button.querySelector("span").textContent="播放独立音频";}
}

$("futureOpen").onclick=openFuture;$("futureClose").onclick=closeFuture;$("futureBack").onclick=closeFuture;
$("futureEnterViewer").onclick=enterFutureViewer;$("futureViewerBack").onclick=exitFutureViewer;$("futureAudioControl").onclick=toggleFutureAudio;
document.querySelectorAll("[data-future-net]").forEach(button=>button.onclick=()=>{futureNetwork=button.dataset.futureNet;renderFutureNetwork();});
document.querySelectorAll("[data-future-qod]").forEach(button=>button.onclick=()=>{futureQod=!futureQod;renderFutureNetwork();});
document.querySelectorAll("[data-future-camera]").forEach(button=>button.onclick=()=>{
  const angle=Number(button.dataset.futureCamera)||0;
  document.querySelectorAll("[data-future-camera]").forEach(item=>item.setAttribute("aria-pressed",String(item===button)));
  futureRequestedAngle=futureAngle=angle;applyFutureAngle(angle);
  $("futureStageStatus").textContent=`${button.querySelector(".future-rig-monitor b").textContent} · 输入视角已锁定`;
});
futureEls.preview.oninput=event=>{
  futurePreviewPending=event.target.value;
  if(futurePreviewFrame)return;
  futurePreviewFrame=requestAnimationFrame(()=>{futurePreviewFrame=0;applyFutureAngle(futurePreviewPending);});
};
futureEls.angle.oninput=event=>requestFutureAngle(event.target.value);
futureEls.dialog.addEventListener("keydown",trapFutureFocus);
futureEls.shell.addEventListener("click",event=>{if(event.target===futureEls.shell)closeFuture();});
futureEls.audience.addEventListener("pointerdown",event=>{
  if(event.target.closest("button,input,.future-3d-layer"))return;
  futureDragging=true;futureDragStartX=event.clientX;futureDragStartAngle=futureRequestedAngle;
  futureEls.audience.setPointerCapture(event.pointerId);
});
futureEls.audience.addEventListener("pointermove",event=>{
  if(!futureDragging)return;requestFutureAngle(futureDragStartAngle+(event.clientX-futureDragStartX)*.08);
});
const endFutureDrag=()=>{futureDragging=false;renderFutureAngle();};
futureEls.audience.addEventListener("pointerup",endFutureDrag);futureEls.audience.addEventListener("pointercancel",endFutureDrag);
futureEls.layer3d.addEventListener("dblclick",()=>{if(future3d&&futureMode==="viewer")future3d.resetView();});

futureEls.video.addEventListener("loadedmetadata",futureMediaReady);
futureEls.video.addEventListener("canplay",futureMediaReady);
futureEls.video.addEventListener("error",futureMediaFailed);
futureEls.video.addEventListener("timeupdate",()=>{
  if(!futureOpen||futureMode!=="production"||futureDragging||!Number.isFinite(futureEls.video.duration)||futureEls.video.duration<=0)return;
  futureAngle=Math.round((futureEls.video.currentTime/futureEls.video.duration)*50-25);futureRequestedAngle=futureAngle;renderFutureAngle();
});
futureEls.audio.addEventListener("error",()=>{$("futureAudioControl").querySelector("span").textContent="独立音频不可用";});
if(futureEls.video.readyState>=1)futureMediaReady();
renderFutureNetwork();renderFutureAngle();
