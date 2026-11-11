// Surveyed crossing locations. Unknown or explicitly absent markings are not
// converted into invented zebra crossings. Pedestrian state is server-owned online.
"use strict";
class CityCrossings {
    constructor(graph, geometry) {
        this.graph=graph;this.geometry=geometry;this.byEdge=new Map();this.items=new Map();
        this.cells=new Map();this.states=new Map();this.serials=new Map();this.blocked=[];this.elapsed=0;
        for(const node of graph.nodes.values()) {
            const tags=node.osmTags||{};
            if(tags.foot==="no"||tags.crossing==="no"||!(tags.highway==="crossing"||tags["crossing:markings"]&&tags["crossing:markings"]!=="no"))continue;
            const edges=[...(graph.adjacent.get(node.id)||[])].sort((a,b)=>b.lanes-a.lanes||a.id.localeCompare(b.id));
            const edge=edges[0];if(!edge)continue;
            const at=edge.from===node.id?0:edge.length,dir=graph.direction(edge,false,at);
            const markings=tags["crossing:markings"];
            const marked=markings!=="no"&&(Boolean(markings)||String(tags.crossing||"").split(";").some(value=>["marked","uncontrolled","zebra"].includes(value)));
            const control=edges.map(road=>geometry.junction(road,road.from===node.id))
                .find(item=>item.signal&&Math.abs(item.dir[0]*dir[0]+item.dir[1]*dir[1])>.7)
                ||geometry.junction(edge,edge.from===node.id);
            const item={id:node.id,index:node.index,x:node.x,y:node.y,edge,at,dir,
                width:geometry.halfWidth(edge,at),layer:geometry.layer(edge),marked,
                bicolour:markings==="zebra:bicolour",control};
            this.items.set(node.id,item);
            const cell=`${Math.floor(node.x/4000)}:${Math.floor(node.y/4000)}`;
            if(!this.cells.has(cell))this.cells.set(cell,[]);
            this.cells.get(cell).push(item);
            if(!this.byEdge.has(edge.id))this.byEdge.set(edge.id,[]);
            this.byEdge.get(edge.id).push(item);
        }
    }
    walkerPoint(crossing,walker) {
        const distance=(crossing.width+28)*(1-2*walker.progress)*walker.side;
        return {x:crossing.x-crossing.dir[1]*distance+crossing.dir[0]*walker.row,
            y:crossing.y+crossing.dir[0]*distance+crossing.dir[1]*walker.row};
    }
    update(game,dt=1/60) {
        if(game.networkTrafficRequired)return;
        this.elapsed+=dt;this.blocked=[];
        const pose=game.cityWorldPose,cx=Math.floor(pose.wx/4000),cy=Math.floor(pose.wy/4000),active=new Set();
        for(let x=cx-1;x<=cx+1;x++)for(let y=cy-1;y<=cy+1;y++)for(const crossing of this.cells.get(`${x}:${y}`)||[]){
            active.add(crossing.id);
            if(!this.states.has(crossing.id))this.states.set(crossing.id,{crossing,serial:this.serials.get(crossing.id)||0,walkers:[],next:this.elapsed+2+hash(crossing.index,11,0)*10});
        }
        const vehicles=(game.localTraffic?.poses()||[]).map(car=>({x:car.wx,y:car.wy,speed:Math.abs(car.speed)*60,w:car.w,h:car.h,
            layer:this.geometry.layer(this.graph.edges.get(car.edge))}));
        vehicles.push({x:pose.wx,y:pose.wy,speed:Math.abs(game.cityWorldSpeed)*60,w:game.bus.w,h:game.bus.h,layer:this.geometry.layer(game.cityEdge)});
        const colors=[[73,119,170],[190,91,72],[99,145,93],[177,143,76],[142,104,163]];
        for(const [id,state] of this.states) {
            const crossing=state.crossing,{width,dir}=crossing;
            if(active.has(id)&&!state.walkers.length&&this.elapsed>=state.next){
                state.serial++;this.serials.set(crossing.id,state.serial);const count=1+Number(hash(crossing.index,state.serial,0)>.6);
                state.walkers=Array.from({length:count},(_,i)=>({id:`local-p-${crossing.index}-${state.serial}-${i}`,
                    side:hash(crossing.index,state.serial*7+i,0)>.5?1:-1,row:(i-(count-1)/2)*18,
                    speed:(1.15+hash(crossing.index,state.serial*13+i,0)*.35)/METERS_PER_PX,
                    progress:0,walking:false,moving:false,color:colors[(crossing.index+state.serial+i)%colors.length]}));
            }
            const nearby=vehicles.filter(car=>car.layer===crossing.layer&&Math.hypot(car.x-crossing.x,car.y-crossing.y)<1800);
            const walkPhase=!crossing.control.signal||this.geometry.pedestrianGreen(crossing.control);
            const clear=walkPhase&&!nearby.some(car=>{
                const dx=car.x-crossing.x,dy=car.y-crossing.y;
                return Math.abs(-dir[1]*dx+dir[0]*dy)<width+car.w/2&&Math.abs(dx*dir[0]+dy*dir[1])<Math.max(car.h/2+40,car.speed*.8);
            });
            for(const walker of state.walkers){
                walker.moving=false;if(!walker.walking&&clear)walker.walking=true;
                if(!walker.walking)continue;
                const previous=walker.progress;walker.progress=Math.min(1,previous+walker.speed*dt/(2*(width+28)));
                const point=this.walkerPoint(crossing,walker);
                if(nearby.some(car=>Math.hypot(point.x-car.x,point.y-car.y)<Math.max(car.w,car.h)/2+12))walker.progress=previous;
                walker.moving=walker.progress>previous;
            }
            const hadWalkers=state.walkers.length;state.walkers=state.walkers.filter(walker=>walker.progress<1);
            if(hadWalkers&&!state.walkers.length)state.next=this.elapsed+25+hash(crossing.index,state.serial*17,0)*25;
            if(state.walkers.some(w=>!w.walking&&walkPhase||w.walking&&(1-w.progress)*2*(width+28)>28))this.blocked.push(crossing);
            if(!active.has(id)&&!state.walkers.length)this.states.delete(id);
        }
    }
    stopRoom(x,y,dx,dy,layer) {
        let room=Infinity;
        for(const crossing of this.blocked){
            if(crossing.layer!==layer||Math.abs(dx*crossing.dir[0]+dy*crossing.dir[1])<.65)continue;
            const vx=crossing.x-x,vy=crossing.y-y,ahead=vx*dx+vy*dy,side=Math.abs(-dy*vx+dx*vy),gap=ahead-122;
            if(gap>=-.01&&side<crossing.width+30&&ahead<1400)room=Math.min(room,Math.max(0,gap));
        }
        return room;
    }
    poses(game=null) {
        if(game?.networkTrafficRequired)return window.citySession?.pedestrians()||[];
        const poses=[];
        for(const state of this.states.values())for(const walker of state.walkers){
            const crossing=state.crossing,point=this.walkerPoint(crossing,walker);
            poses.push({id:walker.id,wx:point.x,wy:point.y,angle:Math.atan2(crossing.dir[1]*walker.side,crossing.dir[0]*walker.side),
                walking:walker.walking,moving:walker.moving,color:walker.color,layer:crossing.layer});
        }
        return poses;
    }
    drawPeople(game,layer,bounds) {
        const time=(Date.now()+(window.citySession?.active?window.citySession.clockOffset:0))/1000;
        for(const person of this.poses(game)) {
            if(person.layer!==layer||person.wx<bounds.minX-50||person.wx>bounds.maxX+50||person.wy<bounds.minY-50||person.wy>bounds.maxY+50)continue;
            const step=person.moving?Math.sin(time*10+person.wx*.01)*4:0;
            ctx.save();ctx.globalAlpha=person.alpha??1;ctx.translate(person.wx,person.wy);ctx.rotate(person.angle);
            circle(2,3,10,[0,0,0],.25);
            line(-4,3,-4,9+step,[30,36,42],3);line(4,3,4,9-step,[30,36,42],3);
            line(-8,-2,-9,4-step,SKIN,3);line(8,-2,9,4+step,SKIN,3);
            fillRect(-7,-8,14,15,person.color,1,4);circle(0,-9,5,SKIN);
            ctx.restore();
        }
    }
    drawRoad(edges,bounds) {
        for(const edge of edges)for(const crossing of this.byEdge.get(edge.id)||[]) {
            if(crossing.x<bounds.minX-300||crossing.x>bounds.maxX+300||crossing.y<bounds.minY-300||crossing.y>bounds.maxY+300)continue;
            const {width,dir}=crossing;
            ctx.save();ctx.translate(crossing.x,crossing.y);ctx.rotate(Math.atan2(dir[0],-dir[1]));
            if(crossing.marked) {
                // Bars run along the road, across both carriageways. The gaps
                // remain visible, and an unmarked crossing keeps plain asphalt.
                const count=Math.max(2,Math.floor(width*2/24)),step=width*2/count;
                for(let i=0;i<count;i++)fillRect(-width+step*i+3,-30,Math.max(5,step-7),60,
                    crossing.bicolour&&i%2?[234,211,84]:[235,237,218],.9);
            }
            for(const side of [-1,1]) {
                const x=side*(width+25);
                line(x,18,x,-25,[80,88,85],4);
                fillRect(x-15,-40,30,30,[31,91,164],1,2);
                poly([[x,-37],[x-12,-13],[x+12,-13]],WHITE);
                circle(x,-30,2.4,[30,36,42]);line(x,-27,x,-20,[30,36,42],2.2);
                line(x,-24,x-5,-21,[30,36,42],2);line(x,-21,x-4,-15,[30,36,42],2);line(x,-21,x+5,-15,[30,36,42],2);
            }
            ctx.restore();
        }
    }
}
