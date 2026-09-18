{
  "name": "game-relay-worker",
  "main": "worker.js",
  "compatibility_date": "2026-09-18",
  "durable_objects": {
    "bindings": [
      { "name": "RELAY", "class_name": "Relay" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_classes": ["Relay"] }
  ]
}
