// Кнопка расширения на панели браузера: открыть окно чата с последним каналом и комнатой.
const ext = globalThis.browser || globalThis.chrome;
ext.action.onClicked.addListener(() => {
  ext.windows.create({ url: 'https://play.multidonate.ru/site/ver?minechat=last', type: 'popup', width: 420, height: 720 });
});
