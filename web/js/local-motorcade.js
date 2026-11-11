// Solo uses its own column. The online client never runs this controller.
"use strict";
class LocalMotorcade {
    constructor(traffic){this.traffic=traffic;this.nextAt=90;this.retryAt=0;this.active=null;this.route=new Map();this.serial=0;}
    step(game){
        const traffic=this.traffic;
        if(this.active){
            if(!this.active.vehicles.some(id=>traffic.cars.has(id))){this.active=null;this.nextAt=traffic.elapsed+600+traffic.random()*240;}
            return;
        }
        if(traffic.elapsed<Math.max(this.nextAt,this.retryAt)||traffic.cars.size+7>traffic.cap)return;
        this.retryAt=traffic.elapsed+12;
        game.cityGeometryAt(0);
        const legs=game.cityGeometryCache.segments.filter(leg=>leg.end>0).map(leg=>({...leg}));
        const seen=new Set(legs.map(leg=>traffic.key(leg.edge,leg.reverse)));
        for(let i=0;i<128&&legs.at(-1).end<6500;i++){
            const previous=legs.at(-1),node=game.cityGraph.endpoint(previous.edge,previous.reverse);
            const next=game.cityDrivingExit(previous.edge,previous.reverse,node);
            if(!next||seen.has(traffic.key(next.edge,next.reverse)))break;
            seen.add(traffic.key(next.edge,next.reverse));
            legs.push({edge:next.edge,reverse:next.reverse,start:previous.end,end:previous.end+next.edge.length});
        }
        const kinds=["police","police","limousine","limousine","limousine","ambulance","police"];
        const sizes={police:[52,96],limousine:[54,132],ambulance:[58,110]};
        const route=legs.slice().reverse().map(leg=>({edge:leg.edge,reverse:!leg.reverse}));
        for(let i=0;i<route.length;i++){
            if(!traffic.canDrive(route[i].edge,route[i].reverse)||i&& !traffic.canTurn(route[i-1].edge,route[i-1].reverse,route[i]))return;
        }
        const plans=new Map(route.slice(0,-1).map((leg,i)=>[traffic.key(leg.edge,leg.reverse),route[i+1]]));
        const oldRoute=this.route;this.route=plans;
        const cars=[],pose=game.cityWorldPose,id=`solo-escort-${++this.serial}`;
        let distance=2800,previousH=0;
        for(const [index,kind] of kinds.entries()){
            const [w,h]=sizes[kind];if(index)distance+=(previousH+h)/2+65;previousH=h;
            const leg=legs.find(leg=>distance>=leg.start&&distance<=leg.end);if(!leg)break;
            const offset=leg.reverse?leg.edge.length-(distance-leg.start):distance-leg.start,reverse=!leg.reverse;
            const car={id:`local-npc-${traffic.serial+index+1}`,edge:leg.edge,reverse,offset,lane:0,
                lateral:37,speed:4,cruise:6.8,color:kind==="limousine"?[22,25,30]:[235,238,240],kind,w,h,convoyId:id,
                travel:0,age:0,far:0,stopped:new Set(),committed:new Set(),stopWait:new Map(),plans:new Map(),
                changing:null,yieldPending:false,braking:false,next:null,arc:null};
            traffic.plan(car);const intent=traffic.laneIntent(car);car.lane=Math.min(traffic.laneCount(car.edge,car.reverse)-1,intent.lane);
            car.lateral=traffic.lateral(car.edge,car.reverse,car.lane,traffic.progress(car));
            car.pose=traffic.lanePosition(car.edge,car.reverse,traffic.progress(car),car.lateral);
            if(Math.hypot(car.pose.x-pose.wx,car.pose.y-pose.wy)<2200||[...traffic.cars.values(),...cars].some(other=>
                Math.hypot(other.pose.x-car.pose.x,other.pose.y-car.pose.y)<((other.h||92)+h)/2+45))break;
            const ahead=traffic.controlAhead(car);
            if(ahead&&ahead.distance<ahead.control.stopLine+h/2+90)break;
            cars.push(car);
        }
        if(cars.length!==kinds.length){this.route=oldRoute;return;}
        traffic.serial+=cars.length;
        for(const car of cars)traffic.cars.set(car.id,car);
        this.active={id,vehicles:cars.map(car=>car.id),started:traffic.elapsed};
    }
    snapshot(){
        if(!this.active)return {phase:"scheduled",starts_in:Math.max(0,Math.round(this.nextAt-this.traffic.elapsed)),closed_nodes:[]};
        const nodes=[];
        for(const reservation of this.traffic.reservations.values()){
            if(reservation.convoyId!==this.active.id)continue;
            const node=this.traffic.graph.nodes.get(reservation.zone.node);if(!node)continue;
            const edges=this.traffic.graph.adjacent.get(node.id)||[];if(edges.length<3)continue;
            nodes.push({node:node.index,wx:node.x,wy:node.y,width:Math.max(...edges.map(edge=>edge.lanes*74)),angle:0,
                layer:Math.min(...edges.map(edge=>this.traffic.geometry.layer(edge)))});
        }
        return {...this.active,phase:"passing",closed_nodes:nodes};
    }
}
