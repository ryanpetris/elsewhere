/*! Wave.js 2.0.5 drawing subset. Copyright (c) 2023 Austin Michaud λ. MIT; see LICENSE. */
// Source and adaptation details are in README.md.
const magnitude = (data, i, count) => {
  const value = data[Math.min(data.length - 1, Math.floor(i * data.length / count))];
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
};

export class Lines {
  constructor(options = {}) { this.options = options; }
  draw(data, canvas, { x = 0, y = 0, width = canvas.canvas.width, height = canvas.canvas.height } = {}) {
    const count = Math.max(1, Math.min(256, Math.floor(this.options.count || data.length || 1)));
    if (!(Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0)) return;
    canvas.beginPath();
    for (let i = 0; i < count; i++) {
      const value = magnitude(data, i, count);
      if (!value) continue;
      if (this.options.radial) {
        const angle = i / count * Math.PI * 2 - Math.PI / 2;
        const radius = Math.min(width, height) * .18;
        const extent = radius + value * Math.min(width, height) * .28;
        canvas.moveTo(x + width / 2 + Math.cos(angle) * radius, y + height / 2 + Math.sin(angle) * radius);
        canvas.lineTo(x + width / 2 + Math.cos(angle) * extent, y + height / 2 + Math.sin(angle) * extent);
      } else {
        const fromX = x + width / count * (i + .5);
        canvas.moveTo(fromX, y + height);
        canvas.lineTo(fromX, y + height - value * height * .95);
      }
    }
    canvas.lineCap = 'butt';
    canvas.lineWidth = this.options.radial ? Math.max(1, Math.min(width, height) * .5 / count) : width / count * .75;
    canvas.strokeStyle = this.options.color;
    canvas.stroke();
  }
}

export class Wave {
  constructor(options = {}) { this.options = options; }
  draw(data, canvas, { x = 0, y = 0, width = canvas.canvas.width, height = canvas.canvas.height } = {}) {
    const count = Math.max(2, Math.min(256, Math.floor(this.options.count || data.length || 2)));
    if (!(Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) || !data.some(value => value > 0 && Number.isFinite(value))) return;
    canvas.beginPath();
    canvas.moveTo(x, y + height);
    for (let i = 0; i < count; i++) {
      canvas.lineTo(x + width * i / (count - 1), y + height - magnitude(data, i, count) * height * .95);
    }
    canvas.lineTo(x + width, y + height);
    canvas.closePath();
    canvas.fillStyle = canvas.strokeStyle = this.options.color;
    canvas.globalAlpha = .25;
    canvas.fill();
    canvas.globalAlpha = 1;
    canvas.lineWidth = Math.max(1, height / 100);
    canvas.stroke();
  }
}
