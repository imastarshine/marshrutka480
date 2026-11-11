import unittest

from backend.config import Settings
from backend.simulation import FIRST_STOP, MAX_SPEED, STOP_GAP, Room


class SimulationTests(unittest.TestCase):
    def room(self, count=1, seconds=180):
        room = Room("ABC234", "Тестовый рейс", True, 8, 1,
                    Settings(round_seconds=seconds, countdown_seconds=0))
        for i in range(1, count + 1):
            player = room.add({"id": i, "username": f"Driver{i}"})
            player.connected = True
        room.start()
        return room

    @staticmethod
    def step(room, seconds, keys=None):
        """Drive fixed server ticks; refresh input only when explicitly requested."""
        for _ in range(round(seconds / .05)):
            if keys is not None:
                for player in room.players.values():
                    player.keys = {"up": False, "down": False, "left": False, "right": False, **keys}
                    player.input_age = 0
            room.step(.05)

    def test_authoritative_speed_and_road_limits(self):
        room = self.room()
        player = room.players[1]
        self.step(room, 10, {"up": True, "right": True})
        self.assertGreater(player.z, 1000)
        self.assertLessEqual(player.speed, MAX_SPEED)
        self.assertLessEqual(player.x, 562)
        self.assertGreaterEqual(player.x, 106)
        self.assertLessEqual(player.distance, 10 * MAX_SPEED)
        self.step(room, 10, {"left": True})
        self.assertGreaterEqual(player.x, 106)
        self.assertGreaterEqual(player.speed, 0)

    def test_stale_or_disconnected_input_stops_bus(self):
        for disconnected in (False, True):
            with self.subTest(disconnected=disconnected):
                room = self.room()
                player = room.players[1]
                player.x = 550  # Isolate dead-man braking from traffic collisions.
                self.step(room, 4, {"up": True})
                self.assertGreater(player.speed, 400)
                if disconnected:
                    player.connected = False
                self.step(room, 3)
                self.assertEqual(player.speed, 0)

    def test_stop_requires_position_low_speed_and_full_dwell(self):
        room = self.room()
        player = room.players[1]
        player.z = FIRST_STOP
        player.x = 411
        self.step(room, 2)
        self.assertEqual(player.score, 0)
        player.x = 550
        self.step(room, 1.4)
        self.assertEqual(player.score, 0)
        self.assertGreater(player.boarding, 0)
        self.step(room, .1)
        self.assertEqual(player.score, 280)
        self.assertEqual(player.stops, 1)
        self.assertEqual(player.served, {0})
        # Staying at the same stop cannot repeatedly award fare or a stop bonus.
        self.step(room, 10)
        self.assertEqual(player.score, 280)
        self.assertEqual(player.stops, 1)

    def test_moving_bus_cannot_collect_passengers(self):
        room = self.room()
        player = room.players[1]
        player.x = 550
        player.z = FIRST_STOP
        player.speed = 300
        self.step(room, .5, {"up": True})
        self.assertEqual(player.stops, 0)
        self.assertEqual(player.score, 0)

    def test_shared_stop_inventory_cannot_be_duplicated(self):
        room = self.room(count=4)
        initial_waiting = room.waiting(0)
        for player in room.players.values():
            player.x = 550
            player.z = FIRST_STOP
        self.step(room, 2)
        passengers = sum((p.score - p.stops * 40) // 60 for p in room.players.values())
        self.assertEqual(passengers, initial_waiting)
        self.assertEqual(room.waiting(0), 0)
        self.assertLessEqual(sum(p.stops for p in room.players.values()), 3)
        snapshot = room.snapshot()
        self.assertTrue(all(s["waiting"] >= 0 for s in snapshot["stops"]))

    def test_collision_is_penalized_by_server_and_does_not_end_shift(self):
        room = self.room()
        player = room.players[1]
        npc = room.npcs()[0]
        player.x, player.z = npc["x"], npc["z"]
        player.speed, player.score = 100, 500
        player.input_age = 0
        room.step(.05)
        self.assertEqual(player.score, 410)
        self.assertLess(player.speed, 20)
        self.assertGreater(player.invulnerable, 0)
        self.assertEqual(room.status, "running")

    def test_round_finishes_once_and_only_served_players_qualify(self):
        room = self.room(count=2, seconds=3)
        room.players[1].x = 550
        room.players[1].z = FIRST_STOP
        self.step(room, 2)
        self.assertEqual(room.players[1].stops, 1)
        self.step(room, 1)
        self.assertEqual(room.status, "finished")
        results = {r["id"]: r for r in room.results}
        self.assertTrue(results[1]["qualified"])
        self.assertFalse(results[2]["qualified"])
        self.assertEqual(results[1]["score"], 280)
        self.assertFalse(room.step(.05))
        self.assertTrue(all(p.speed == 0 for p in room.players.values()))

    def test_restart_resets_score_inventory_and_round_id(self):
        room = self.room(seconds=2)
        player = room.players[1]
        player.x, player.z = 550, FIRST_STOP
        first_id, initial_waiting = room.round_id, room.waiting(0)
        self.step(room, 2)
        self.assertEqual(room.status, "finished")
        room.start()
        self.assertNotEqual(room.round_id, first_id)
        self.assertEqual(player.score, 0)
        self.assertEqual(player.stops, 0)
        self.assertEqual(player.z, 0)
        self.assertEqual(room.waiting(0), initial_waiting)
        self.assertEqual(room.results, [])

    def test_world_snapshot_remains_bounded_for_far_apart_players(self):
        room = self.room(count=8)
        for i, player in enumerate(room.players.values()):
            player.z = i * 1000000
        snapshot = room.snapshot()
        self.assertLessEqual(len(snapshot["npcs"]), 8 * 5 * 3)
        self.assertLessEqual(len(snapshot["stops"]), 8 * 4)
        self.assertEqual(len(snapshot["players"]), 8)
        self.assertIn("ул.", snapshot["street"])
