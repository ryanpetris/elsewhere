// Takes ownership of frame, including on error. Stream sizes are physical video pixels.
export function visibleVideoFrame(frame, { width, height }) {
  try {
    const rect = frame.visibleRect;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 ||
        !rect || width > rect.width || height > rect.height) {
      throw new Error(`Decoded video does not contain the configured ${width}×${height} image`);
    }
    if (rect.width === width && rect.height === height && frame.displayWidth === width && frame.displayHeight === height) return frame;
    // Hardware encoders can expose alignment padding beyond the right and bottom edges.
    const view = new VideoFrame(frame, {
      visibleRect: { x: rect.x, y: rect.y, width, height },
      displayWidth: width, displayHeight: height,
    });
    frame.close();
    return view;
  } catch (error) {
    frame.close();
    throw error;
  }
}
