# Invader Hunt

A small Flash Invaders-style web app. Take a photo of an invader; the app checks your GPS position and compares the photo to reference images on the device using MobileNet (TensorFlow.js).

- Edit `data.json` to set each invader's name, coordinates, points and reference photos (in `refs/`).
- `radiusMeters` is how close you must be; `similarityThreshold` is the minimum match score.
- Open the page with `?selftest` to see how similar the reference images are to each other.
