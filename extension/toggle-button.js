// Button controls keep the existing boolean setting API and change events.
const ToggleButton = (() => {
  function attach(button) {
    if (button.dataset.toggleReady) return button;
    button.dataset.toggleReady = '1';
    let checked = !!button.checked;
    const label = button.textContent || '选择';
    Object.defineProperty(button, 'checked', {get:()=>checked,set(value){checked=!!value;button.setAttribute('aria-pressed',String(checked));button.textContent=label+(checked?' · 已选':' · 未选');}});
    button.checked = checked;
    button.addEventListener('click',()=>{button.checked=!button.checked;button.dispatchEvent(new Event('change',{bubbles:true}));});
    return button;
  }
  document.querySelectorAll('button[data-toggle]').forEach(attach);
  return {attach};
})();
