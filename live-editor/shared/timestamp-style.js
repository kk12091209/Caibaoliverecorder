export const TIMESTAMP_STYLE_SETTING='preview-timestamp-style';
export const TIMESTAMP_STYLES=Object.freeze([
  Object.freeze({value:'outline',label:'极简描边'}),
  Object.freeze({value:'inline',label:'清晰分隔'}),
  Object.freeze({value:'stacked',label:'双层时钟'})
]);
export const DEFAULT_TIMESTAMP_STYLE='outline';
export const TIMESTAMP_POSITION_SETTING='preview-timestamp-position';
export const TIMESTAMP_POSITIONS=Object.freeze([
  Object.freeze({value:'top-left',label:'左上角'}),
  Object.freeze({value:'top-right',label:'右上角'}),
  Object.freeze({value:'bottom-left',label:'左下角'}),
  Object.freeze({value:'bottom-right',label:'右下角'})
]);
export const DEFAULT_TIMESTAMP_POSITION='top-left';

export function validateTimestampStyle(value) {
  if(!TIMESTAMP_STYLES.some(style=>style.value===value))throw new Error('请选择有效的时间戳样式。');
  return value;
}
export function normalizedTimestampStyle(value) {
  try{return validateTimestampStyle(value);}catch{return DEFAULT_TIMESTAMP_STYLE;}
}
export const savedTimestampStyle=store=>normalizedTimestampStyle(store.setting(TIMESTAMP_STYLE_SETTING));

export function validateTimestampPosition(value) {
  if(!TIMESTAMP_POSITIONS.some(position=>position.value===value))throw new Error('请选择有效的时间戳位置。');
  return value;
}
export function normalizedTimestampPosition(value) {
  try{return validateTimestampPosition(value);}catch{return DEFAULT_TIMESTAMP_POSITION;}
}
export const savedTimestampPosition=store=>normalizedTimestampPosition(store.setting(TIMESTAMP_POSITION_SETTING));
