// Fit the encoded video inside a surface without cropping. Pixel rounding,
// overlay margins and source validation remain with the individual renderer.
export function containedVideoFrame(width,height,sourceWidth,sourceHeight) {
  const scale=Math.min(width/sourceWidth,height/sourceHeight);
  const frameWidth=sourceWidth*scale,frameHeight=sourceHeight*scale;
  return {scale,width:frameWidth,height:frameHeight,left:(width-frameWidth)/2,top:(height-frameHeight)/2};
}
