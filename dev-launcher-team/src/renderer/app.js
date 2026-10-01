'use strict';

(function () {
  const navItems = document.querySelectorAll('.nav-item');
  const views = {
    projects:       document.getElementById('view-projects'),
    projectsMobile: document.getElementById('view-projectsMobile'),
    qr:             document.getElementById('view-qr'),
    qrParse:        document.getElementById('view-qrParse'),
    qrRead:         document.getElementById('view-qrRead'),
    ducsaTools:     document.getElementById('view-ducsaTools'),
    b2bCreds:       document.getElementById('view-b2bCreds'),
    graphUsers:     document.getElementById('view-graphUsers'),
    plexoCards:     document.getElementById('view-plexoCards'),
    plexoRefund:    document.getElementById('view-plexoRefund'),
    factura:        document.getElementById('view-factura'),
    reportes:       document.getElementById('view-reportes'),
    oneSignal:      document.getElementById('view-oneSignal'),
    osDirect:       document.getElementById('view-osDirect'),
    outlook:        document.getElementById('view-outlook'),
    jira:           document.getElementById('view-jira'),
    jsonTool:       document.getElementById('view-jsonTool'),
    jwtDecode:      document.getElementById('view-jwtDecode'),
    hosts:          document.getElementById('view-hosts')
  };

  function setActive(name) {
    Object.entries(views).forEach(([k, el]) => el.classList.toggle('active', k === name));
    navItems.forEach(b => b.classList.toggle('active', b.dataset.view === name));
    // Aviso para vistas que cargan datos en forma lazy (ej: deudas) al activarse.
    document.dispatchEvent(new CustomEvent('view:change', { detail: { view: name } }));
  }

  navItems.forEach(b => b.addEventListener('click', () => setActive(b.dataset.view)));

  window.__router = { setActive };

  if (window.api.onTrayNavigate) {
    window.api.onTrayNavigate((view) => setActive(view));
  }
})();
