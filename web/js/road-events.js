// Arcade road facilities with permanent geographic addresses. These are game
// events, not a claim that a real police post occupies this OSM coordinate.
"use strict";
class CityRoadEvents {
    constructor(graph,geometry) {
        this.graph=graph;this.geometry=geometry;this.posts=[];this.byEdge=new Map();
        const stops=new Map();
        for(const route of Object.values(graph.data.routes))for(const stop of [...(route.stops||[]),...(route.returnStops||[])]){
            if(!stops.has(stop.edge))stops.set(stop.edge,[]);
            const road=graph.edges.get(stop.edge);if(road)stops.get(stop.edge).push(stop.offset??stop.at*road.length);
        }
        for(const edge of graph.edges.values()){
            const tags=edge.osmTags||{};
            if(edge.length<3000||edge.length>30000||edge.lanes<4||geometry.layer(edge)!==0||tags.bridge&&tags.bridge!=="no"||tags.tunnel&&tags.tunnel!=="no")continue;
            if(!["primary","secondary","tertiary","trunk"].includes(tags.highway)||hash(edge.index,edge.index*7,0x445053)>.28)continue;
            const at=edge.length*(.35+.3*hash(edge.index,91,0x445053));
            if((stops.get(edge.id)||[]).some(offset=>Math.abs(offset-at)<500))continue;
            const a=graph.direction(edge,false,at-160),b=graph.direction(edge,false,at+160);
            if(a[0]*b[0]+a[1]*b[1]<.975)continue;
            const reverse=!graph.canTraverse(edge,false)||graph.canTraverse(edge,true)&&hash(edge.index,33,0x445053)>.5;
            const [x,y]=graph.position(edge,at),dir=graph.direction(edge,reverse,at),width=geometry.halfWidth(edge,at);
            const post={id:`dps-${edge.id}`,edge,at,x,y,dir,width,reverse,angle:Math.atan2(dir[0],-dir[1])};
            const corners=[[width,-95],[width+145,-95],[width+145,155],[width,155]].map(([side,ahead])=>[x-dir[1]*side-dir[0]*ahead,y+dir[0]*side-dir[1]*ahead]);
            post.bounds={minX:Math.min(...corners.map(p=>p[0]))-20,maxX:Math.max(...corners.map(p=>p[0]))+20,
                minY:Math.min(...corners.map(p=>p[1]))-20,maxY:Math.max(...corners.map(p=>p[1]))+20};
            post.car=new Police(width+94,0);post.car.y=26;
            this.posts.push(post);this.byEdge.set(edge.id,post);
        }
        this.resetObserver();
    }
    resetObserver() {this.previous=null;}
    resetShift() {this.checked=new Set();this.escortNotices=new Set();this.escortViolations=new Set();this.resetEscort();this.resetObserver();}
    resetEscort(){this.escortNotices=new Set();this.escortViolations=new Set();this.escortCompleted=new Set();this.escortWait=0;this.escortNear=false;this.escortCurrent=null;}
    motorcade(game) {
        return game.networkTrafficRequired?window.citySession?.state?.motorcade:game.localTraffic?.motorcade?.snapshot();
    }
    observeMotorcade(game,pose,old) {
        if(game.networkTrafficRequired&&performance.now()-(window.citySession?.received||0)>1000){this.escortWait=0;this.escortNear=false;return;}
        const event=this.motorcade(game);if(!event||event.phase!=="passing"){if(event?.last_event?.id===this.escortCurrent&&event.last_event.outcome==="cancelled")this.escortWait=0;this.finishEscortWait(game);return;}
        if(this.escortCurrent!==event.id){this.finishEscortWait(game);this.escortCurrent=event.id;}
        const cars=game.cityTrafficActors().filter(car=>car.convoy_id===event.id);
        if(cars.some(car=>Math.hypot(car.wx-pose.wx,car.wy-pose.wy)<2500)&&!this.escortNotices.has(event.id)){
            this.escortNotices.add(event.id);game.showBanner("Рядом кортеж · уступи дорогу сопровождению",[130,185,255],240);
        }
        let near=false;
        for(const node of event.closed_nodes||[]){
            if(node.layer!==undefined&&node.layer!==this.geometry.layer(game.cityEdge))continue;
            const dx=Math.sin(pose.angle),dy=-Math.cos(pose.angle),vx=node.wx-pose.wx,vy=node.wy-pose.wy;
            const ahead=vx*dx+vy*dy,side=Math.abs(-dy*vx+dx*vy),line=node.width/2+game.bus.h/2+34;
            if(ahead>-80&&ahead<line+450&&side<node.width/2+100)near=true;
            if(old&&!this.escortViolations.has(event.id)){
                const before=(node.wx-old.wx)*dx+(node.wy-old.wy)*dy;
                if(before>line&&ahead<=line&&ahead>0&&side<node.width/2&&Math.abs(game.cityWorldSpeed)*KMH>20){
                    this.escortViolations.add(event.id);game.money-=700;game.addRep(-2);
                    game.showBanner("Не уступил кортежу · штраф 700 ₽",ORANGE,240);this.escortWait=0;
                }
            }
        }
        if(near&&Math.abs(game.bus.speed)<.3&&!this.escortViolations.has(event.id))this.escortWait++;
        if(this.escortNear&&!near)this.finishEscortWait(game);
        this.escortNear=near;
    }
    finishEscortWait(game) {
        if(this.escortWait>=120&&this.escortCurrent&&!this.escortCompleted.has(this.escortCurrent)&&!this.escortViolations.has(this.escortCurrent)){
            this.escortCompleted.add(this.escortCurrent);
            if(game.storyFlags)game.storyFlags.motorcadeOk=true;
            game.missionComplete("КОРТЕЖ ПРОЕХАЛ!",0,1);game.showBanner("Перекрытие снято · можно ехать",GREEN,180);
        }
        this.escortWait=0;this.escortNear=false;
    }
    reserved(bounds) {
        return this.posts.some(({bounds:b})=>b.minX<bounds.maxX&&b.maxX>bounds.minX&&b.minY<bounds.maxY&&b.maxY>bounds.minY);
    }
    update(game) {
        if(game.state!=="play")return;
        this.checked ||= new Set();
        const pose=game.cityWorldPose,old=this.previous;this.previous=pose;
        this.observeMotorcade(game,pose,old);
        if(!old||Math.hypot(pose.wx-old.wx,pose.wy-old.wy)>500)return;
        const post=this.byEdge.get(game.cityEdge.id);if(!post||this.checked.has(post.id))return;
        const {dir}=post;
        const before=(old.wx-post.x)*dir[0]+(old.wy-post.y)*dir[1],after=(pose.wx-post.x)*dir[0]+(pose.wy-post.y)*dir[1];
        const side=-(pose.wx-post.x)*dir[1]+(pose.wy-post.y)*dir[0];
        if(before>=0||after<0||Math.abs(side)>post.width+BAY_W+game.bus.w||Math.sin(pose.angle)*dir[0]-Math.cos(pose.angle)*dir[1]<.7)return;
        this.checked.add(post.id);
        const kmh=Math.round(Math.abs(game.cityWorldSpeed)*KMH);
        if(kmh>SPEED_LIMIT){
            const fine=Math.round((100+(kmh-SPEED_LIMIT)*10)*(1-.15*game.level("blat"))/50)*50;
            game.money-=fine;game.addRep(-1);
            game.showBanner(`ДПС · радар ${kmh} км/ч · штраф ${fine} ₽`,[255,160,110],240);
            game.floatText(`Радар −${fine} ₽`,game.bus.x,game.bus.y-25,ORANGE,true);
        }else{
            if(game.storyFlags)game.storyFlags.radarOk=true;
            game.showBanner("ДПС: счастливого пути!",[150,215,190],140);
        }
    }
    drawClosures(game,layer,bounds) {
        if(game.networkTrafficRequired&&performance.now()-(window.citySession?.received||0)>1500)return;
        const event=this.motorcade(game);if(event?.phase!=="passing")return;
        for(const node of event.closed_nodes||[]){
            if((node.layer??0)!==layer||node.wx<bounds.minX-300||node.wx>bounds.maxX+300||node.wy<bounds.minY-300||node.wy>bounds.maxY+300)continue;
            ctx.save();ctx.translate(node.wx,node.wy);ctx.rotate(node.angle||0);
            for(const side of [-1,1]){
                const x=side*(node.width/2+25),y=side*35;
                circle(x+3,y+3,10,[0,0,0],.22);fillRect(x-7,y-5,14,19,[60,90,65],1,4);circle(x,y-11,6,SKIN);
                ring(x,y-14,6,[34,53,68],3);line(x,y,x-side*30,y-7,WHITE,4);line(x,y,x-side*15,y-3.5,[30,35,40],4);
                fillRect(x-25,y+25,50,20,[30,71,136],1,4);text("ДПС",x,y+35,WHITE,11,{bold:true,align:"center",base:"middle"});
            }
            ctx.restore();
        }
    }
    static drawVehicle(car,frame) {
        const w=car.w||50,h=car.h||92,r=rect(-w/2,-h/2,w,h);
        drawCarBody(r,car.color||[145,155,165],car.braking);
        if(!car.kind||car.kind==="car")return;
        if(car.kind==="police"){
            fillRect(-w/2,-h/2+37,w,15,[31,80,160]);text("ДПС",0,-h/2+44,WHITE,9,{bold:true,align:"center",base:"middle"});
        }else if(car.kind==="limousine"){
            line(-w/2+3,-h/2+28,-w/2+3,h/2-16,[165,176,185],2);line(w/2-3,-h/2+28,w/2-3,h/2-16,[165,176,185],2);
            fillRect(-w/2+7,-h/2+38,w-14,h-68,[37,43,49],1,4);
            for(const side of [-1,1]){const x=side*(w/2-1);line(x,-h/2+16,x,-h/2-7,[190,195,199],2);
                fillRect(x,-h/2-9,12,9,WHITE);fillRect(x,-h/2-6,12,3,[45,85,185]);fillRect(x,-h/2-3,12,3,[220,50,45]);}
        }else if(car.kind==="ambulance"){
            fillRect(-4,-7,8,28,[220,55,48]);fillRect(-14,3,28,8,[220,55,48]);
        }
        if(car.kind==="police"||car.kind==="ambulance"){
            const on=Math.floor(frame/6)%2===0;
            fillRect(-w/2+7,-h/2+27,w/2-8,6,on?[255,65,55]:[120,39,40],1,2);
            fillRect(1,-h/2+27,w/2-8,6,on?[35,55,120]:[70,160,255],1,2);
            circle(0,-h/2+30,35,on?[255,65,55]:[70,160,255],.14);
        }
    }
    draw(edges,frame,bounds) {
        frame=Math.floor((Date.now()+(window.citySession?.active?window.citySession.clockOffset:0))/1000*60);
        for(const edge of edges){
            const post=this.byEdge.get(edge.id);if(!post)continue;
            const b=post.bounds;if(b.maxX<bounds.minX||b.minX>bounds.maxX||b.maxY<bounds.minY||b.minY>bounds.maxY)continue;
            ctx.save();ctx.translate(post.x,post.y);ctx.rotate(post.angle);
            const r=post.width;
            fillRect(r,-88,145,243,[160,164,151],1,9);
            fillRect(r+20,-74,62,70,[0,0,0],.24,5);fillRect(r+15,-80,62,70,[226,230,229],1,5);
            fillRect(r+15,-55,62,17,[39,81,151]);text("ДПС",r+46,-47,WHITE,15,{bold:true,align:"center",base:"middle"});
            fillRect(r+23,-72,20,12,GLASS,1,2);fillRect(r+49,-72,20,12,GLASS,1,2);
            const px=r+34,py=38;
            circle(px+2,py+5,10,[0,0,0],.2);fillRect(px-7,py,14,18,[61,91,64],1,4);
            circle(px,py-6,7,SKIN);ring(px,py-9,6,[40,60,72],3);
            const angle=Math.sin(frame*.08)*.4;
            line(px-5,py+6,px-26,py+6+Math.sin(angle)*12,WHITE,4);
            line(px-5,py+6,px-15,py+6+Math.sin(angle)*6,[30,35,40],4);
            post.car.draw(frame);
            const sx=-r-24,sy=265;
            line(sx,sy+10,sx,sy+32,[70,76,72],3);circle(sx,sy,16,WHITE);ring(sx,sy,14,RED,4);
            text(String(SPEED_LIMIT),sx,sy,[25,32,36],12,{bold:true,align:"center",base:"middle"});
            poly([[r+22,26],[r-160,-90],[r-160,145]],[250,85,70],.035+.025*Math.sin(frame*.08));
            ctx.restore();
        }
    }
}
