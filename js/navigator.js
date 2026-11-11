// Personal GPS: legal directed road paths, shared geographic map, no scene swaps.
"use strict";
(() => {
    const inside=(x,y,r)=>x>=r.x&&x<=r.x+r.w&&y>=r.y&&y<=r.y+r.h;
    const nav=g=>g.gps||(g.gps={zoom:.025,x:g.wx,y:g.wy,legs:[],keys:new Set()});
    const palette=[[226,142,104],[92,206,163],[122,174,255],[235,135,175],[200,164,245],[90,210,225]];
    function mapData(g,n) {
        if(n.graph===g.cityGraph)return;
        n.graph=g.cityGraph;n.mapRoute=g.route.num;n.routes=new Map();n.stops=[];
        n.bounds={minX:Infinity,minY:Infinity,maxX:-Infinity,maxY:-Infinity};
        for(const node of g.cityGraph.nodes.values()){
            n.bounds.minX=Math.min(n.bounds.minX,node.x);n.bounds.maxX=Math.max(n.bounds.maxX,node.x);
            n.bounds.minY=Math.min(n.bounds.minY,node.y);n.bounds.maxY=Math.max(n.bounds.maxY,node.y);
        }
        for(const [index,[number,route]] of Object.entries(g.cityGraph.data.routes).entries()){
            n.routes.set(number,{...route,number,color:palette[index%palette.length],
                edges:new Set([...(route.path||[]),...(route.returnPath||[])].map(leg=>typeof leg==="string"?leg:leg.edge))});
            for(const stop of [...(route.stops||[]),...(route.returnStops||[])]){
                const edge=g.cityGraph.edges.get(stop.edge);if(!edge)continue;
                const offset=stop.offset??stop.at*edge.length;if(!Number.isFinite(offset))continue;
                const reverse=Boolean(stop.reverse);
                const existing=n.stops.find(item=>item.edge.id===edge.id&&item.reverse===reverse&&Math.abs(item.offset-offset)<50);
                if(existing){existing.routes.add(number);continue;}
                const [x,y]=g.cityGraph.position(edge,offset);
                n.stops.push({edge,offset,reverse,x,y,name:stop.name||"Остановка",routes:new Set([number])});
            }
        }
    }
    function zoomAt(g,factor,x=null,y=null) {
        const n=nav(g),old=n.zoom,next=clamp(old*factor,.00015,.8),area=n.view?.area;
        if(area&&x!==null&&y!==null&&inside(x,y,area)){
            const dx=x-area.x-area.w/2,dy=y-area.y-area.h/2;
            n.x+=dx/old-dx/next;n.y+=dy/old-dy/next;
        }
        n.zoom=next;
    }
    function drawStops(g,n,toMap,area) {
        n.stopHits=[];const occupied=[];
        for(const stop of n.stops){
            if(!stop.routes.has(n.mapRoute))continue;
            const [x,y]=toMap(stop.x,stop.y);if(!inside(x,y,area))continue;
            circle(x,y,5,[12,25,32]);circle(x,y,3.5,[239,205,96]);
            n.stopHits.push({...stop,sx:x,sy:y});
            if(n.zoom<.015)continue;
            const label=g.fitMinimapText(stop.name,145,10),w=textWidth(label,10,true)+8;
            const box={x:clamp(x+9,area.x+3,area.x+area.w-w-3),y:clamp(y-15,area.y+3,area.y+area.h-17),w,h:15};
            if(occupied.some(other=>hit(inflate(box,3,2),other)))continue;
            occupied.push(box);fillRect(box.x,box.y,box.w,box.h,[12,25,32],.92,3);
            text(label,box.x+4,box.y+2,[239,216,138],10,{bold:true});n.stopHits.at(-1).box=box;
        }
    }
    function clearPlans(g) {
        const n=nav(g);
        for(const key of n.keys)if(g.cityPlannedSelections.get(key)?.gps)g.cityPlannedSelections.delete(key);
        n.keys.clear();g.cityPlanRevision++;g.cityGeometryCache=null;g.cityNavigationCache=null;g.cityDrivingCache=null;
    }
    function plan(g) {
        const n=nav(g), target=n.target, graph=g.cityGraph;
        if(!target)return;
        const oldPlans=new Map(g.cityPlannedSelections), oldKeys=new Set(n.keys), before=g.cityWorldPose;
        n.lastEdge=g.cityEdge.id;n.lastReverse=g.cityReverse;
        const heap=[],best=new Map();
        const push=item=>{heap.push(item);let i=heap.length-1;while(i){const p=(i-1)>>1;if(heap[p].score<=item.score)break;heap[i]=heap[p];i=p;}heap[i]=item;};
        const pop=()=>{const first=heap[0],last=heap.pop();if(heap.length){let i=0;while(i*2+1<heap.length){let c=i*2+1;if(c+1<heap.length&&heap[c+1].score<heap[c].score)c++;if(heap[c].score>=last.score)break;heap[i]=heap[c];i=c;}heap[i]=last;}return first;};
        const add=(edge,reverse,from,cost,prev)=>{
            const end=reverse?0:edge.length;
            const goal=edge.id===target.edge.id&&(target.reverse===undefined||reverse===target.reverse)&&(reverse?target.offset<=from:target.offset>=from);
            const to=goal?target.offset:end, total=cost+Math.abs(to-from), point=graph.position(edge,to);
            const key=`${edge.id}:${reverse}:${goal}`;
            if((best.get(key)??Infinity)<=total)return;
            best.set(key,total);push({edge,reverse,from,to,cost:total,goal,key,prev,
                score:total+(goal?0:Math.hypot(point[0]-target.x,point[1]-target.y))});
        };
        add(g.cityEdge,g.cityReverse,g.cityOffset,0,null);
        let found=null;
        for(let count=0;heap.length&&count<100000;count++) {
            const item=pop();if(best.get(item.key)!==item.cost)continue;
            if(item.goal){found=item;break;}
            const node=graph.endpoint(item.edge,item.reverse),key=g.citySelectionKey(item.edge,item.reverse,node);
            const fixed=g.cityWorldCommitted.get(key);
            for(const next of graph.outgoingFrom(node)) {
                if(!graph.canTurn(item.edge,node,next.edge,next.reverse))continue;
                if(fixed&&(next.edge.id!==fixed.edge.id||next.reverse!==fixed.reverse))continue;
                add(next.edge,next.reverse,next.reverse?next.edge.length:0,item.cost,item);
            }
        }
        if(!found){n.message="Нет разрешённого пути к этой точке";return false;}
        clearPlans(g);n.legs=[];n.deferred=false;
        for(let item=found;item;item=item.prev)n.legs.unshift({edge:item.edge,reverse:item.reverse,from:item.from,to:item.to});
        for(let i=0;i<n.legs.length-1;i++) {
            const leg=n.legs[i],next=n.legs[i+1],key=g.citySelectionKey(leg.edge,leg.reverse);
            if(g.cityWorldCommitted.has(key))continue;
            g.cityPlannedSelections.set(key,{edge:next.edge.id,reverse:next.reverse,gps:true});n.keys.add(key);
        }
        n.message="Маршрут построен";g.cityPlanRevision++;g.cityGeometryCache=null;g.cityNavigationCache=null;g.cityDrivingCache=null;
        const after=g.cityWorldPose;
        if(Math.hypot(after.wx-before.wx,after.wy-before.wy)>.1||Math.abs(Math.atan2(Math.sin(after.angle-before.angle),Math.cos(after.angle-before.angle)))>.001){
            g.cityPlannedSelections=oldPlans;n.keys=oldKeys;n.legs=[];n.message="Заверши текущий поворот — GPS перестроится";
            n.deferred=true;n.deferredTravel=g.cityTravel;
            g.cityPlanRevision++;g.cityGeometryCache=null;g.cityNavigationCache=null;g.cityDrivingCache=null;
        }
        return true;
    }
    function routeLine(g,toMap,width=4) {
        const n=nav(g);ctx.strokeStyle="#73e6ba";ctx.lineWidth=width;ctx.lineJoin="round";ctx.lineCap="round";
        for(const leg of n.legs) {
            let from=leg.from;if(leg===n.legs[0]&&leg.edge.id===g.cityEdge.id)from=g.cityOffset;
            const low=Math.min(from,leg.to),high=Math.max(from,leg.to);
            const points=[g.cityGraph.position(leg.edge,low),...leg.edge.geometry.filter((p,i)=>leg.edge.distances[i]>low&&leg.edge.distances[i]<high),g.cityGraph.position(leg.edge,high)];
            ctx.beginPath();points.forEach((p,i)=>ctx[i?"lineTo":"moveTo"](...toMap(...p)));ctx.stroke();
        }
        if(n.target){const [x,y]=toMap(n.target.x,n.target.y);circle(x,y,8,[255,114,99]);ring(x,y,12,WHITE,2);}
    }
    function remaining(g) {
        const n=nav(g);return n.legs.reduce((sum,leg,i)=>sum+Math.abs(leg.to-(i===0&&leg.edge.id===g.cityEdge.id?g.cityOffset:leg.from)),0)*METERS_PER_PX;
    }
    const tick=Game.prototype.tick;
    Game.prototype.tick=function(){tick.call(this);const n=this.gps;if(!n?.target)return;
        if(n.lastEdge!==this.cityEdge.id||n.lastReverse!==this.cityReverse){
            const index=n.legs.findIndex((leg,i)=>i>0&&leg.edge.id===this.cityEdge.id&&leg.reverse===this.cityReverse);
            if(index>0&&!n.deferred){n.legs.splice(0,index);n.legs[0].from=this.cityOffset;n.lastEdge=this.cityEdge.id;n.lastReverse=this.cityReverse;}
            else plan(this);
        }else if(n.deferred&&Math.abs(this.cityTravel-n.deferredTravel)>180)plan(this);
        const p=this.cityWorldPose;
        const onFinalRoad=n.legs.length===1&&this.cityEdge.id===n.target.edge.id;
        const aligned=n.target.reverse===undefined||n.target.reverse===this.cityReverse;
        const arrived=aligned&&onFinalRoad&&Math.abs(this.cityOffset-n.target.offset)<140;
        if(arrived||aligned&&n.legs.length&&Math.hypot(p.wx-n.target.x,p.wy-n.target.y)<140&&remaining(this)<25){clearPlans(this);n.target=null;n.legs=[];n.message="Вы прибыли к точке GPS";this.showBanner(n.message,GREEN,180);}
    };
    const reset=Game.prototype.reset;
    Game.prototype.reset=function(){reset.call(this);this.gps=null;};
    const mini=Game.prototype.drawMinimap;
    Game.prototype.drawMinimap=function(){mini.call(this);if(!this.gps?.target)return;
        const r=this.minimapRect(),p=this.cityWorldPose,scale=40/BLOCK,cx=r.x+r.w/2,cy=r.y+r.h/2;
        ctx.save();ctx.beginPath();ctx.rect(r.x,r.y,r.w,r.h);ctx.clip();routeLine(this,(x,y)=>[cx+(x-p.wx)*scale,cy+(y-p.wy)*scale],3);circle(cx,cy,4,YELLOW);ctx.restore();
        text(`GPS ${Math.round(remaining(this))} м`,r.x+6,r.y+r.h-17,[115,230,186],11,{bold:true});
    };
    Game.prototype.drawRouteOverview=function(){
        const n=nav(this),area={x:18,y:106,w:WIDTH-36,h:HEIGHT-250},scale=n.zoom;
        const toMap=(x,y)=>[area.x+area.w/2+(x-n.x)*scale,area.y+area.h/2+(y-n.y)*scale];
        mapData(this,n);n.view={area,toMap,scale};
        fillRect(0,0,WIDTH,HEIGHT,[12,22,29]);text("НАВИГАТОР",22,22,WHITE,26,{bold:true});
        text("Клик — точка GPS · тяни карту · колесо — масштаб",22,61,[158,184,193],12);
        n.buttons=[{x:18,y:area.y+area.h+12,w:48,h:34,label:"−",action:"out"},{x:74,y:area.y+area.h+12,w:48,h:34,label:"+",action:"in"},
            {x:130,y:area.y+area.h+12,w:60,h:34,label:"Я",action:"center"},{x:198,y:area.y+area.h+12,w:134,h:34,label:"Весь город",action:"all"},
            {x:340,y:area.y+area.h+12,w:125,h:34,label:"Сброс GPS",action:"clear"},{x:WIDTH-146,y:20,w:126,h:33,label:"Закрыть · M",action:"close"}];
        fillRect(area.x,area.y,area.w,area.h,[25,38,46],1,8);ctx.save();ctx.beginPath();ctx.rect(area.x,area.y,area.w,area.h);ctx.clip();
        const cacheKey=`${n.x}:${n.y}:${scale}:${n.mapRoute}`;
        if(n.baseKey!==cacheKey){
            const output=ctx,base=document.createElement("canvas");base.width=WIDTH;base.height=HEIGHT;
            ctx=base.getContext("2d");ctx.save();ctx.beginPath();ctx.rect(area.x,area.y,area.w,area.h);ctx.clip();
        const radius=Math.max(area.w,area.h)/scale/2;
        const edges=radius>400000?[...this.cityGraph.edges.values()]:this.cityGraph.nearbyEdges(n.x,n.y,radius);
        const named=new Set(),labels=[],selected=n.routes.get(n.mapRoute);
        for(const edge of edges){
            const b=edge.bounds;if(b.minX>n.x+radius||b.maxX<n.x-radius||b.minY>n.y+radius||b.maxY<n.y-radius)continue;
            ctx.strokeStyle=selected?.edges.has(edge.id)?"#789faa":"#68777c";ctx.lineWidth=Math.max(1,Math.min(8,edge.lanes*scale*24));ctx.beginPath();edge.geometry.forEach((p,i)=>ctx[i?"lineTo":"moveTo"](...toMap(...p)));ctx.stroke();
            if(scale>.012&&edge.length*scale>40&&!named.has(edge.street)&&!/^безымян/i.test(edge.street)){
                const [x,y]=toMap(...this.cityGraph.position(edge,edge.length/2));const label=this.fitMinimapText(edge.street,130,10),box={x:x-textWidth(label,10)/2-3,y:y-2,w:textWidth(label,10)+6,h:16};
                if(inside(box.x,box.y,area)&&inside(box.x+box.w,box.y+box.h,area)&&!labels.some(other=>hit(inflate(box,8,8),other))){labels.push(box);text(label,x,y,[181,199,203],10,{align:"center",shadow:true});named.add(edge.street);}
            }
        }
            ctx.restore();ctx=output;n.base=base;n.baseKey=cacheKey;
        }
        ctx.drawImage(n.base,0,0);
        routeLine(this,toMap,4);drawStops(this,n,toMap,area);
        n.postHits=[];
        if(scale>.003)for(const post of this.cityEvents?.posts||[]){const [sx,sy]=toMap(post.x,post.y);if(!inside(sx,sy,area))continue;
            fillRect(sx-7,sy-7,14,14,[48,114,211],.95,3);text("Д",sx,sy,WHITE,10,{bold:true,align:"center",base:"middle"});n.postHits.push({...post,sx,sy});}
        let escortLabel=false;
        for(const car of this.cityTrafficActors())if(car.convoy_id){const [sx,sy]=toMap(car.wx,car.wy);if(!inside(sx,sy,area))continue;
            circle(sx,sy,6,[15,28,38]);ring(sx,sy,5,car.kind==="limousine"?YELLOW:[100,175,255],2);
            if(!escortLabel){text("Кортеж",sx+9,sy-15,[125,191,255],11,{bold:true,shadow:true});escortLabel=true;}}
        window.citySession?.drawMinimap(this,{bx:area.x,by:area.y,size:area.w,width:area.w,height:area.h,toMap,cx:area.x+area.w/2,cy:area.y+area.h/2,overview:true});
        const p=this.cityWorldPose,[x,y]=toMap(p.wx,p.wy);circle(x,y,9,[12,22,29]);ring(x,y,9,YELLOW,2);
        ctx.save();ctx.translate(x,y);ctx.rotate(p.angle);poly([[0,-11],[-6,7],[0,3],[6,7]],YELLOW);ctx.restore();ctx.restore();
        for(const b of n.buttons){fillRect(b.x,b.y,b.w,b.h,[43,62,70],1,6);text(b.label,b.x+b.w/2,b.y+b.h/2,WHITE,12,{align:"center",base:"middle",bold:true});}
        n.routeButtons=[...n.routes.keys()].map((number,i)=>({x:100+i*82,y:area.y+area.h+58,w:72,h:25,number}));
        text("Схема:",22,area.y+area.h+64,[151,175,183],12);
        for(const b of n.routeButtons){fillRect(b.x,b.y,b.w,b.h,n.mapRoute===b.number?[75,98,107]:[30,47,57],1,5);text(`№ ${b.number}`,b.x+b.w/2,b.y+b.h/2,n.routes.get(b.number).color,12,{align:"center",base:"middle",bold:true});}
        const value=remaining(this);text(this.fitMinimapText(n.notice||(n.target?(n.legs.length?`До точки: ${value>=1000?(value/1000).toFixed(1)+" км":Math.round(value)+" м"} · ${n.target.name||n.target.edge.street}`:n.message):(n.message||"Поставь точку на дороге — GPS построит путь")),WIDTH-44,13),22,HEIGHT-49,n.notice?ORANGE:n.target?GREEN:WHITE,13,{bold:true});
        text("M / Esc — за руль · стрелки — сдвиг карты · © OpenStreetMap",22,HEIGHT-24,[151,175,183],11);
    };
    const click=Game.prototype.onClick;
    Game.prototype.onClick=function(x,y){if(!this.mapOverview)return click.call(this,x,y);
        const n=nav(this);mapData(this,n);if(n.dragged){n.dragged=false;return;}
        const line=n.routeButtons?.find(b=>inside(x,y,b));if(line){n.mapRoute=line.number;return;}
        const button=n.buttons?.find(b=>inside(x,y,b));
        if(button){if(button.action==="close")this.toggleRouteMap();if(button.action==="in")zoomAt(this,1.6);if(button.action==="out")zoomAt(this,1/1.6);if(button.action==="center"){n.x=this.wx;n.y=this.wy;}if(button.action==="clear"){clearPlans(this);n.target=null;n.legs=[];n.message="";n.notice="";}
            if(button.action==="all"){const b=n.bounds;n.x=(b.minX+b.maxX)/2;n.y=(b.minY+b.maxY)/2;n.zoom=Math.min((WIDTH-65)/(b.maxX-b.minX),(HEIGHT-270)/(b.maxY-b.minY));}return;}
        const v=n.view;if(!v||!inside(x,y,v.area))return;
        const post=n.postHits?.find(post=>Math.hypot(x-post.sx,y-post.sy)<12);
        if(post){const previous=n.target;n.target={edge:post.edge,offset:post.at,x:post.x,y:post.y,reverse:post.reverse,name:"Пост ДПС"};if(plan(this)===false){n.target=previous;n.notice=n.message;}else n.notice="";return;}
        const stop=n.stopHits?.filter(stop=>Math.hypot(x-stop.sx,y-stop.sy)<13||stop.box&&inside(x,y,stop.box)).sort((a,b)=>Math.hypot(x-a.sx,y-a.sy)-Math.hypot(x-b.sx,y-b.sy))[0];
        if(stop){const previous=n.target;n.target={...stop};if(plan(this)===false){n.target=previous;n.notice=n.message;}else n.notice="";return;}
        const wx=n.x+(x-v.area.x-v.area.w/2)/v.scale,wy=n.y+(y-v.area.y-v.area.h/2)/v.scale;
        let nearest=null;for(const edge of this.cityGraph.nearbyEdges(wx,wy,25/v.scale)){const p=this.cityGraph.project(edge,wx,wy);if(!nearest||p.distance<nearest.distance)nearest={...p,edge};}
        if(nearest&&nearest.distance*v.scale<24){const previous=n.target;n.target={edge:nearest.edge,offset:nearest.offset,x:nearest.point[0],y:nearest.point[1]};if(plan(this)===false){n.target=previous;n.notice=n.message;}else n.notice="";}else n.message="Выбери точку ближе к дороге";
    };
    const key=Game.prototype.onKey;
    Game.prototype.onKey=function(code,down){if(this.mapOverview&&down&&["ArrowLeft","ArrowRight","ArrowUp","ArrowDown","Equal","Minus"].includes(code)){
        const n=nav(this),step=90/n.zoom;if(code==="ArrowLeft")n.x-=step;if(code==="ArrowRight")n.x+=step;if(code==="ArrowUp")n.y-=step;if(code==="ArrowDown")n.y+=step;if(code==="Equal")n.zoom=Math.min(.8,n.zoom*1.6);if(code==="Minus")n.zoom=Math.max(.00015,n.zoom/1.6);return;
    }return key.call(this,code,down);};
    const toggle=Game.prototype.toggleRouteMap;
    Game.prototype.toggleRouteMap=function(){if(!this.mapOverview){const n=nav(this);n.x=this.wx;n.y=this.wy;}return toggle.call(this);};
    let drag=null;
    canvas.addEventListener("wheel",event=>{if(!game.mapOverview)return;event.preventDefault();const r=canvas.getBoundingClientRect();zoomAt(game,event.deltaY<0?1.25:.8,(event.clientX-r.left)*WIDTH/r.width,(event.clientY-r.top)*HEIGHT/r.height);},{passive:false});
    canvas.addEventListener("pointerdown",event=>{if(!game.mapOverview)return;const n=nav(game),r=canvas.getBoundingClientRect(),x=(event.clientX-r.left)*WIDTH/r.width,y=(event.clientY-r.top)*HEIGHT/r.height;if(n.view&&inside(x,y,n.view.area)){n.dragged=false;drag={x:event.clientX,y:event.clientY,cx:n.x,cy:n.y,zoom:n.zoom};canvas.setPointerCapture(event.pointerId);}});
    canvas.addEventListener("pointermove",event=>{if(!drag||!game.mapOverview)return;const n=nav(game),r=canvas.getBoundingClientRect(),dx=(event.clientX-drag.x)*WIDTH/r.width,dy=(event.clientY-drag.y)*HEIGHT/r.height;if(Math.hypot(dx,dy)>5){n.dragged=true;n.x=drag.cx-dx/drag.zoom;n.y=drag.cy-dy/drag.zoom;}});
    for(const type of ["pointerup","pointercancel"])canvas.addEventListener(type,()=>{drag=null;});
})();
