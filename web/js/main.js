// One original game loop for both solo and multiplayer. Networking never gates input.
"use strict";
const game = new Game();
const citySession = window.citySession = new CitySession();
const keyMap = {ArrowUp:"up",ArrowDown:"down",ArrowLeft:"left",ArrowRight:"right",KeyW:"up",KeyS:"down",KeyA:"left",KeyD:"right"};
function isTextControl(target) {return target instanceof Element && Boolean(target.closest("input,textarea,select,[contenteditable=true]"));}
function releaseKeys() {
    Object.keys(game.keys).forEach(key=>game.keys[key]=false);
    document.querySelectorAll(".controls .on").forEach(b=>b.classList.remove("on"));
}
window.addEventListener("keydown",e=>{
    if(window.app?.panelOpen){
        if(e.code==="Escape"){e.preventDefault();window.app.closePanel();}
        if(e.code==="Tab")window.app.trapFocus(e);
        return;
    }
    if(isTextControl(e.target))return;
    if(e.target instanceof Element&&e.target.closest("button,a")&&["Space","Enter"].includes(e.code))return;
    if(e.code==="KeyF"&&!e.repeat){e.preventDefault();window.app?.fullscreen();return;}
    if(["ArrowUp","ArrowDown","ArrowLeft","ArrowRight","Space"].includes(e.code))e.preventDefault();
    if(!e.repeat||keyMap[e.code])game.onKey(e.code,true);
});
window.addEventListener("keyup",e=>{
    if(keyMap[e.code])game.keys[keyMap[e.code]]=false;
    if(!isTextControl(e.target))game.onKey(e.code,false);
});
window.addEventListener("blur",releaseKeys);
window.addEventListener("pagehide",releaseKeys);
document.addEventListener("visibilitychange",()=>{releaseKeys();last=performance.now();acc=0;});
if(matchMedia("(pointer: coarse)").matches||location.search.includes("touch"))document.body.classList.add("touch");
document.querySelectorAll("[data-key]").forEach(button=>{
    const set=on=>e=>{
        e.preventDefault();
        if(on){try{button.setPointerCapture(e.pointerId);}catch(_){}}
        game.keys[button.dataset.key]=on;button.classList.toggle("on",on);
    };
    button.addEventListener("pointerdown",set(true));
    for(const event of ["pointerup","pointercancel","lostpointercapture"])button.addEventListener(event,set(false));
    button.addEventListener("contextmenu",e=>e.preventDefault());
});
const hornButton=document.querySelector("[data-action=horn]");
hornButton.addEventListener("pointerdown",e=>{
    e.preventDefault();hornButton.classList.add("on");
    game.onKey("Space",true);
});
for(const event of ["pointerup","pointercancel","pointerleave"])hornButton.addEventListener(event,()=>hornButton.classList.remove("on"));
document.querySelector("[data-action=pause]").addEventListener("pointerdown",e=>{e.preventDefault();releaseKeys();game.togglePause();});
canvas.addEventListener("click",e=>{
    canvas.focus({preventScroll:true});
    const rect=canvas.getBoundingClientRect();
    game.onClick((e.clientX-rect.left)*WIDTH/rect.width,(e.clientY-rect.top)*HEIGHT/rect.height);
});
const STEP=1000/60;let last=performance.now(),acc=0;
function loop(now){
    acc=Math.min(acc+Math.max(0,now-last),100);last=now;
    while(acc>=STEP){citySession.beforeTick(game);game.tick();acc-=STEP;}
    ctx=screenCtx;game.draw();
    requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
