from backend.models import CityPoseMessage
from pydantic import ValidationError
from tests.support import AppCase, ORIGIN


def pose(seq=1, **changes):
    return {"type":"pose", "seq":seq, "wx":0.0, "wy":1200.0,
            "lateral":110.0, "angle":0.0, "speed":0.0, "jump":0.0,
            "door":0.0, "braking":False, "bus":"gazel", "route":"480",
            "state":"play", "street":"ул. Ленина", **changes}


class OriginalCityTests(AppCase):
    def city(self, session, name="Original city"):
        response=self.client.post('/api/rooms', headers=self.auth(session),
            json={"name":name,"public":False,"max_players":8,"mode":"city"})
        self.assertEqual(response.status_code,201,response.text)
        return response.json()['room']

    def test_join_running_city_and_relay_original_bus_pose(self):
        host=self.register('HostCity'); guest=self.register('GuestCity')
        room=self.city(host)
        self.assertEqual(room['mode'],'city')
        self.assertEqual(room['status'],'running')
        self.assertEqual(self.join(guest,room).status_code,200)
        with self.client.websocket_connect('/ws',headers={'Origin':ORIGIN}) as a:
            self.ws_auth(a,host,room)
            with self.client.websocket_connect('/ws',headers={'Origin':ORIGIN}) as b:
                self.ws_auth(b,guest,room)
                a.send_json(pose(bus='liaz',route='112',angle=1.570796,wx=3000.0))
                for _ in range(15):
                    state=self.receive_type(b,'state')
                    player=next(p for p in state['players'] if p['id']==host['user']['id'])
                    if 'wx' in player: break
                self.assertEqual(player['wx'],3000)
                self.assertEqual(player['bus'],'liaz')
                self.assertEqual(player['route'],'112')
                self.assertFalse(state['ranked'])
                a.send_json({'type':'horn'})
                self.assertEqual(self.receive_type(b,'horn')['player_id'],host['user']['id'])

    def test_pose_validation_and_teleport_correction(self):
        for update in ({'wx':float('nan')},{'angle':float('inf')},{'bus':'tank'},
                       {'speed':1000},{'score':999999},{'lateral':900}):
            with self.assertRaises(ValidationError): CityPoseMessage.model_validate(pose(**update))
        session=self.register(); room=self.city(session)
        with self.client.websocket_connect('/ws',headers={'Origin':ORIGIN}) as ws:
            self.ws_auth(ws,session,room)
            ws.send_json(pose())
            ws.send_json(pose(2,wx=900000.0))
            correction=self.receive_type(ws,'correction')
            self.assertEqual(correction['pose']['wx'],0)
            ws.send_json(pose(3,wy=1198.0,speed=1.0))
            for _ in range(15):
                state=self.receive_type(ws,'state')
                if state['players'][0].get('wy')==1198: break
            self.assertEqual(state['players'][0]['wy'],1198)

    def test_reconnect_keeps_original_city_position_and_avatar(self):
        session=self.register();room=self.city(session)
        with self.client.websocket_connect('/ws',headers={'Origin':ORIGIN}) as ws:
            self.ws_auth(ws,session,room);ws.send_json(pose(wx=-4500.0,bus='paz'))
            for _ in range(15):
                state=self.receive_type(ws,'state')
                if state['players'][0].get('wx')==-4500: break
        with self.client.websocket_connect('/ws',headers={'Origin':ORIGIN}) as ws:
            self.ws_auth(ws,session,room)
            player=self.receive_type(ws,'state')['players'][0]
            self.assertEqual(player['wx'],-4500)
            self.assertEqual(player['bus'],'paz')

    def test_leaving_city_releases_player_memory_and_number(self):
        host=self.register('CityHost');guest=self.register('CityGuest')
        room=self.city(host);self.join(guest,room)
        live=self.app.state.rooms.rooms[room['code']]
        self.assertEqual(live.players[guest['user']['id']].number,2)
        self.client.post('/api/rooms/'+room['code']+'/leave',headers=self.auth(guest),json={})
        self.assertNotIn(guest['user']['id'],live.players)
        self.join(guest,room)
        self.assertEqual(live.players[guest['user']['id']].number,2)

    def test_local_career_scores_cannot_enter_ranked_leaderboard(self):
        session=self.register();room=self.city(session)
        with self.client.websocket_connect('/ws',headers={'Origin':ORIGIN}) as ws:
            self.ws_auth(ws,session,room)
            ws.send_json(pose(score=999999,stops=100))
            self.assertEqual(self.receive_type(ws,'error')['type'],'error')
        self.assertEqual(self.client.get('/api/leaderboard').json()['entries'],[])
