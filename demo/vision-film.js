(()=>{
  const shell=document.getElementById("visionShell");
  const video=document.getElementById("visionVideo");
  const openButton=document.getElementById("futureOpen");
  const closeButton=document.getElementById("visionClose");
  const startButton=document.getElementById("visionStart");
  const ended=document.getElementById("visionEnded");
  const replay=document.getElementById("visionReplay");
  const spatialButtons=[document.getElementById("visionEnterSpatial"),document.getElementById("visionEnterSpatialEnd")];
  const openSpatialFuture=window.openFuture;
  let filmOpen=false;
  let returnFocus=null;

  function pauseStudio(){
    try{tiles.forEach(tile=>tile.vd.pause());}catch(_error){}
  }

  function resumeStudio(){
    try{if(live)void synchronizeMediaTransition();}catch(_error){}
  }

  async function playFilm(){
    startButton.hidden=true;
    ended.hidden=true;
    try{await video.play();}
    catch(_error){startButton.hidden=false;}
  }

  function openFilm(){
    if(filmOpen)return;
    filmOpen=true;
    returnFocus=document.activeElement;
    pauseStudio();
    video.currentTime=0;
    shell.hidden=false;
    document.body.classList.add("vision-film-open");
    requestAnimationFrame(()=>shell.classList.add("open"));
    setTimeout(()=>closeButton.focus(),20);
    setTimeout(()=>void playFilm(),40);
  }

  function closeFilm({resume=true}={}){
    if(!filmOpen)return;
    filmOpen=false;
    video.pause();
    shell.classList.remove("open");
    document.body.classList.remove("vision-film-open");
    ended.hidden=true;
    startButton.hidden=false;
    setTimeout(()=>{if(!filmOpen)shell.hidden=true;},210);
    if(resume)resumeStudio();
    if(returnFocus&&typeof returnFocus.focus==="function")setTimeout(()=>returnFocus.focus(),0);
  }

  function enterSpatial(){
    // 先恢复主演示媒体状态，让空间原型自己的 suspend/resume 能准确记住进入前状态。
    closeFilm({resume:true});
    setTimeout(()=>openSpatialFuture(),220);
  }

  openButton.onclick=openFilm;
  window.openFuture=openFilm;
  closeButton.onclick=()=>closeFilm();
  startButton.onclick=()=>void playFilm();
  replay.onclick=()=>{video.currentTime=0;void playFilm();};
  spatialButtons.forEach(button=>button.onclick=enterSpatial);
  video.addEventListener("play",()=>{startButton.hidden=true;ended.hidden=true;});
  video.addEventListener("ended",()=>{ended.hidden=false;});
  video.addEventListener("error",()=>{startButton.hidden=false;startButton.querySelector("b").textContent="影片加载失败，点击重试";});
  shell.addEventListener("click",event=>{if(event.target===shell)closeFilm();});

  addEventListener("keydown",event=>{
    if(!filmOpen)return;
    if(event.key==="Escape"){
      event.preventDefault();event.stopImmediatePropagation();closeFilm();return;
    }
    if(event.code==="Space"&&!event.target.matches("button,input")){
      event.preventDefault();event.stopImmediatePropagation();
      video.paused?void playFilm():video.pause();
      return;
    }
    if(event.key.toLowerCase()==="v"){
      event.preventDefault();event.stopImmediatePropagation();closeFilm();
    }
  },true);
})();
