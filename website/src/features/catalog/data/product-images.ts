import recorderwebp480 from '../../../assets/products/recorder-480.webp'
import recorderwebp800 from '../../../assets/products/recorder-800.webp'
import recorderwebp1120 from '../../../assets/products/recorder-1120.webp'
import recorderwebp1440 from '../../../assets/products/recorder-1440.webp'
import recorderwebp2560 from '../../../assets/products/recorder-2560.webp'
import recorderavif480 from '../../../assets/products/recorder-480.avif'
import recorderavif800 from '../../../assets/products/recorder-800.avif'
import recorderavif1120 from '../../../assets/products/recorder-1120.avif'
import recorderavif1440 from '../../../assets/products/recorder-1440.avif'
import recorderavif2560 from '../../../assets/products/recorder-2560.avif'
import teleprompterwebp480 from '../../../assets/products/teleprompter-480.webp'
import teleprompterwebp800 from '../../../assets/products/teleprompter-800.webp'
import teleprompterwebp1120 from '../../../assets/products/teleprompter-1120.webp'
import teleprompterwebp1440 from '../../../assets/products/teleprompter-1440.webp'
import teleprompterwebp2560 from '../../../assets/products/teleprompter-2560.webp'
import teleprompteravif480 from '../../../assets/products/teleprompter-480.avif'
import teleprompteravif800 from '../../../assets/products/teleprompter-800.avif'
import teleprompteravif1120 from '../../../assets/products/teleprompter-1120.avif'
import teleprompteravif1440 from '../../../assets/products/teleprompter-1440.avif'
import teleprompteravif2560 from '../../../assets/products/teleprompter-2560.avif'

export const recorderImage = {
  src: recorderwebp2560,
  srcSet: `${recorderwebp480} 480w, ${recorderwebp800} 800w, ${recorderwebp1120} 1120w, ${recorderwebp1440} 1440w, ${recorderwebp2560} 2560w`,
  avifSrcSet: `${recorderavif480} 480w, ${recorderavif800} 800w, ${recorderavif1120} 1120w, ${recorderavif1440} 1440w, ${recorderavif2560} 2560w`,
  width: 2560,
  height: 2364,
}

export const teleprompterImage = {
  src: teleprompterwebp2560,
  srcSet: `${teleprompterwebp480} 480w, ${teleprompterwebp800} 800w, ${teleprompterwebp1120} 1120w, ${teleprompterwebp1440} 1440w, ${teleprompterwebp2560} 2560w`,
  avifSrcSet: `${teleprompteravif480} 480w, ${teleprompteravif800} 800w, ${teleprompteravif1120} 1120w, ${teleprompteravif1440} 1440w, ${teleprompteravif2560} 2560w`,
  width: 2560,
  height: 2264,
}
