// One camera transform for the complete city: roads, stops and every vehicle.
"use strict";
class CityWorldRenderer {
    constructor(graph, geometry, events=null) {
        this.graph = graph; this.geometry = geometry;
        this.events=events;
        this.scenery = new CitySceneryWorld(graph, { roadHalfWidth: (edge) => geometry.maxHalfWidth(edge),
            isReserved: bounds=>Boolean(events?.reserved(bounds)) });
        this.stops = new Map();
        for (const [number, route] of Object.entries(graph.data.routes)) {
            for (const stop of [...(route.stops || []), ...(route.returnStops || [])]) {
                const edge = graph.edges.get(stop.edge);
                if (!edge) continue;
                const offset = stop.offset ?? stop.at * edge.length;
                if (!Number.isFinite(offset)) continue;
                if (!this.stops.has(edge.id)) this.stops.set(edge.id, []);
                const entries = this.stops.get(edge.id), reverse = Boolean(stop.reverse);
                const existing = entries.find((item) => item.reverse === reverse && Math.abs(item.offset - offset) < 70);
                if (existing) { existing.routes.add(number); continue; }
                const sprite = new BusStop(null, -BusStop.HEIGHT / 2, { num: number, wait: [0,0] }, 50, { ...stop, route: number });
                sprite.waiting = 0;
                entries.push({ offset, reverse, routes: new Set([number]), sprite });
            }
        }
    }
    stroke(points, color, width, lateral = 0, dash = null, offset = 0) {
        if (points.length < 2) return;
        ctx.beginPath();
        for (const [index, p] of points.entries()) {
            const d = typeof lateral === "function" ? lateral(p) : lateral;
            ctx[index ? "lineTo" : "moveTo"](p.x + p.nx * d, p.y + p.ny * d);
        }
        ctx.strokeStyle = color; ctx.lineWidth = width;
        ctx.setLineDash(dash || []); ctx.lineDashOffset = offset; ctx.stroke(); ctx.setLineDash([]);
    }
    sidewalks(entries,bounds) {
        const clip=new Path2D();
        ctx.fillStyle=col(SIDEWALK);
        for(const [,mesh] of entries){ctx.fill(mesh.sidewalk);clip.addPath(mesh.sidewalk);}
        ctx.save();ctx.clip(clip);ctx.strokeStyle="rgba(116,121,111,.38)";ctx.lineWidth=1;
        ctx.beginPath();
        for(let x=Math.floor(bounds.minX/32)*32;x<=bounds.maxX;x+=32){ctx.moveTo(x,bounds.minY);ctx.lineTo(x,bounds.maxY);}
        for(let y=Math.floor(bounds.minY/32)*32;y<=bounds.maxY;y+=32){ctx.moveTo(bounds.minX,y);ctx.lineTo(bounds.maxX,y);}
        ctx.stroke();ctx.restore();
        ctx.strokeStyle="#777e75";ctx.lineWidth=3;
        for(const [,mesh] of entries)ctx.stroke(mesh.sidewalk);
    }
    lamps(edge,bounds) {
        const tags=edge.osmTags||{};
        if(tags.lit==="no"||tags.tunnel&&tags.tunnel!=="no"||!["primary","secondary","tertiary","unclassified","residential"].includes(tags.highway))return;
        const address=sceneryRoadAddress({cityGraph:this.graph},edge),post=this.events?.byEdge.get(edge.id);
        const from=(this.graph.adjacent.get(edge.from)?.length||0)>=3?this.geometry.junction(edge,true).width/2+60:0;
        const end=edge.length-((this.graph.adjacent.get(edge.to)?.length||0)>=3?this.geometry.junction(edge,false).width/2+60:0);
        for(let at=Math.ceil((address.prefix+from)/480)*480-address.prefix;at<end;at+=480){
            if(post&&Math.abs(post.at-at)<350)continue;
            const [x,y]=this.graph.position(edge,at),dir=this.geometry.direction(edge,at),width=this.geometry.halfWidth(edge,at);
            if(x<bounds.minX-300||x>bounds.maxX+300||y<bounds.minY-300||y>bounds.maxY+300)continue;
            ctx.save();ctx.translate(x,y);ctx.rotate(Math.atan2(dir[0],-dir[1]));
            for(const side of [-1,1]){
                const sx=side*(width+21);
                circle(sx+4,5,6,[45,53,45],.28);circle(sx,0,5,[97,102,96]);
                line(sx,0,sx-side*34,-5,[91,96,99],5);circle(sx-side*34,-5,6,[255,237,158]);
                circle(sx-side*34,-5,15,[255,240,170],.1);
            }
            ctx.restore();
        }
    }
    markings(edge, mesh) {
        const crossAt = (node) => (this.graph.adjacent.get(node) || []).length >= 3;
        const begin = crossAt(edge.from) ? this.geometry.junction(edge, true).width / 2 + 16 : 0;
        const end = edge.length - (crossAt(edge.to) ? this.geometry.junction(edge, false).width / 2 + 16 : 0);
        if (end <= begin) return;
        const point = (at) => {
            const [x,y] = this.graph.position(edge, at), d = this.geometry.direction(edge, at);
            return {at,x,y,nx:-d[1],ny:d[0],width:this.geometry.halfWidth(edge,at)};
        };
        const points = [point(begin), ...mesh.points.filter((p) => p.at > begin && p.at < end), point(end)];
        for (const side of [-1,1]) this.stroke(points, "#deded4", 2.5, (p) => side * (p.width - 7));
        if (!edge.oneway) for (const side of [-1,1]) this.stroke(points,"#e5e5df",2,side*3);
        // Fixed world chainage, independent of the selected route or camera.
        for (const side of [-1,1]) for (let lane = 1; lane < 3; lane++) {
            let strip = [];
            const flush = () => { this.stroke(strip,"#d7d7d0",2.5,side*lane*74,[30,30],-(strip[0]?.at || 0)); strip=[]; };
            for (const p of points) { if (p.width > lane*74+16) strip.push(p); else flush(); }
            flush();
        }
    }
    controls(game, edge) {
        for (const reverse of [false,true]) {
            const control = this.geometry.junction(edge, reverse);
            if (!control.signal && !control.stop && !control.yield) continue;
            const at = reverse ? control.stopLine : edge.length - control.stopLine;
            const [x,y] = this.geometry.point(edge,at);
            const forward = this.geometry.direction(edge,at), dir = reverse ? forward.map((value)=>-value) : forward;
            const width = this.geometry.halfWidth(edge,at);
            ctx.save(); ctx.translate(x,y); ctx.rotate(Math.atan2(dir[0],-dir[1]));
            line(5,0,width-7,0,WHITE,4);
            if (control.signal) {
                const state = this.geometry.signalState(control, window.citySession);
                fillRect(width+12,-48,23,65,[25,29,30],1,6);
                for (const [i,color] of [[0,RED],[1,YELLOW],[2,GREEN]]) {
                    const active = state === ["red","yellow","green"][i];
                    circle(width+23,-36+i*20,7,color,active?1:.2);
                    if (active) circle(width+23,-36+i*20,12,color,.16);
                }
            } else if (control.stop) {
                fillRect(width+10,-28,36,23,RED,1,5);
                text("STOP",width+28,-16,WHITE,10,{bold:true,align:"center",base:"middle"});
            } else {
                poly([[width+12,-30],[width+44,-30],[width+28,-3]],RED);
                poly([[width+17,-27],[width+39,-27],[width+28,-10]],WHITE);
            }
            ctx.restore();
        }
    }
    stopPlatforms(game, edge) {
        for (const entry of this.stops.get(edge.id) || []) {
            const active = game.stops.find((stop) => stop.cityEdge === edge.id && stop.cityReverse === entry.reverse &&
                Math.abs(stop.cityOffset-entry.offset) < 70);
            const stop = active || entry.sprite, oldEdge = stop.edge, oldY = stop.y;
            const [x,y] = this.graph.position(edge,entry.offset), dir = this.graph.direction(edge,entry.reverse,entry.offset);
            ctx.save(); ctx.translate(x,y); ctx.rotate(Math.atan2(dir[0],-dir[1]));
            // BusStop's local drawing origin is the old road middle. It is now
            // anchored to a permanent surveyed stop, never the current segment.
            ctx.translate(-roadMiddle(),0);
            stop.y = -BusStop.HEIGHT/2; stop.edge = roadMiddle()+this.geometry.halfWidth(edge,entry.offset);
            stop.draw(game.frame, active && active === game.currentStop());
            stop.edge = oldEdge; stop.y = oldY; ctx.restore();
        }
    }
    actorPosition(actor) {
        return [actor.wx+Math.cos(actor.angle)*(actor.lateral||0),actor.wy+Math.sin(actor.angle)*(actor.lateral||0)];
    }
    visible(camera,x,y,pad=200) {
        const b=camera.bounds; return x>=b.minX-pad&&x<=b.maxX+pad&&y>=b.minY-pad&&y<=b.maxY+pad;
    }
    draw(game, withBus=true) {
        const camera = game.cityCamera; camera.update(game);
        ctx = screenCtx;
        fillRect(0,0,WIDTH,HEIGHT,GROUND);
        ctx.save(); camera.apply(ctx);
        this.scenery.drawWorld(ctx,camera.bounds);
        const edges = this.geometry.visibleEdges(camera.bounds).sort((a,b)=>this.geometry.layer(a)-this.geometry.layer(b));
        const layers = new Map();
        for (const edge of edges) {
            const layer=this.geometry.layer(edge);
            if (!layers.has(layer)) layers.set(layer,[]);
            layers.get(layer).push([edge,this.geometry.mesh(edge)]);
        }
        // All traffic keeps its actual position even on a street not selected
        // by this driver's navigator. No projection onto the current road.
        const session=window.citySession, labels=[];
        if (session) { session.drawnTraffic=0; session.drawnPlayers=0; }
        const actors=game.cityTrafficActors(), players=session?.active?session.players():[];
        const actorLayer=(actor)=>{const edge=this.graph.edges.get(actor.edge);return edge?this.geometry.layer(edge):0;};
        const drawActors=(layer)=>{
            for (const car of actors) {
                if (actorLayer(car) !== layer) continue;
                const [x,y]=this.actorPosition(car);
                if (!this.visible(camera,x,y)) continue;
                ctx.save(); ctx.globalAlpha=car.alpha??1; ctx.translate(x,y); ctx.rotate(car.angle);
                drawCarBody(rect(-(car.w||50)/2,-(car.h||92)/2,car.w||50,car.h||92),car.color||[145,155,165],car.braking);
                ctx.restore(); if(session)session.drawnTraffic++;
            }
            game.cityCrossings.drawPeople(game,layer,camera.bounds);
            if (session?.active) for (const player of players) {
                if (actorLayer(player) !== layer) continue;
                if (!session.visible(player)) continue;
                const [x,y]=this.actorPosition(player);
                if (!this.visible(camera,x,y)) continue;
                let bus=session.buses.get(player.id);
                if(!bus||bus.model.key!==player.bus||bus.route!==player.route) {
                    bus=new Bus({},BUS_MODELS.find((model)=>model.key===player.bus)||BUS_MODELS[0],player.route);
                    session.buses.set(player.id,bus);
                }
                bus.speed=player.speed;bus.braking=player.braking;bus.doorOpen=player.door;
                ctx.save();ctx.globalAlpha=player.connected === false ? .35 : 1;
                bus.draw(game.frame,{x,y:y-(player.jump||0)*.3,angle:player.angle});ctx.restore();
                labels.push({player,x,y,h:bus.h});session.drawnPlayers++;
            }
            // Boarding pedestrians remain attached to their fixed stop's frame.
            for (const walker of game.walkers) {
                const stop=walker.stop, edge=this.graph.edges.get(stop.cityEdge);
                if(!edge || this.geometry.layer(edge)!==layer)continue;
                const [x,y]=this.graph.position(edge,stop.cityOffset),dir=this.graph.direction(edge,stop.cityReverse,stop.cityOffset);
                ctx.save();ctx.translate(x,y);ctx.rotate(Math.atan2(dir[0],-dir[1]));
                ctx.translate(-roadMiddle(),-stop.centerY);walker.draw();ctx.restore();
            }
            if(withBus && this.geometry.layer(game.cityEdge)===layer) {
                const pose=game.cityWorldPose;
                game.bus.draw(game.frame,{x:pose.wx,y:pose.wy,angle:pose.angle});
                if(game.hornT) {
                    ctx.save();ctx.translate(pose.wx,pose.wy);ctx.rotate(pose.angle);
                    for(let i=0;i<3;i++) {const k=(26-game.hornT)/26+i*.25;if(k>1)continue;
                        ctx.strokeStyle=col(YELLOW,(1-k)*.8);ctx.lineWidth=3;ctx.beginPath();
                        ctx.arc(0,-game.bus.h/2,20+k*90,-Math.PI*.8,-Math.PI*.2);ctx.stroke();}
                    ctx.restore();
                }
            }
        };
        for (const [layer,entries] of layers) {
            this.sidewalks(entries,camera.bounds);
            ctx.fillStyle=col(ASPHALT);
            for (const [,mesh] of entries) ctx.fill(mesh.road);
            for (const [edge,mesh] of entries) this.markings(edge,mesh);
            game.cityCrossings.drawRoad(entries.map(([edge])=>edge),camera.bounds);
            for (const [edge] of entries) { this.stopPlatforms(game,edge); this.controls(game,edge); }
            for(const [edge] of entries)this.lamps(edge,camera.bounds);
            game.cityEvents?.draw(entries.map(([edge])=>edge),game.frame,camera.bounds);
            drawActors(layer);
        }
        ctx.restore();
        for(const {player,x,y,h} of labels) {
            const [sx,sy]=camera.worldToScreen(x,y), label=`${player.number} · ${player.username}`;
            const width=Math.min(200,textWidth(label,12,true)+18), top=sy-h*camera.scale/2-29;
            fillRect(sx-width/2,top,width,22,[14,23,20],.94,4);
            text(label,sx,top+11,session.color(player),12,{bold:true,align:"center",base:"middle"});
            if((session.horns.get(player.id)||0)>performance.now())text("БИП!",sx+30,sy-20,YELLOW,14,{bold:true});
        }
        for(const particle of game.particles)if(particle.world)particle.draw();
        for(const item of game.texts)item.draw();
    }
}
