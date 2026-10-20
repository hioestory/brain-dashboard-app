// 화면이 그려지기 전에 테마를 정한다 (깜빡임 방지). 저장값: light | dark, 없으면 시스템 설정을 따른다
(function () {
  try {
    var t = localStorage.getItem("dash.theme");
    if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
  } catch (e) {}
})();
