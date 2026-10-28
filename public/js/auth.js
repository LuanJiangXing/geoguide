// js/auth.js — shared auth state module
(function() {
  // CSRF token from cookie (set by server on login)
  function getCsrfToken() {
    var match = document.cookie.match(/(^|; )geoguide_csrf=([^;]*)/);
    return match ? match[2] : '';
  }
  window._csrfToken = getCsrfToken();

  window._user = null;
  window._authReady = new Promise(function(resolve) {
    fetch('/api/auth?action=me')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        window._user = data.user;
        resolve(window._user);
        initNav();
      })
      .catch(function() {
        window._user = null;
        resolve(null);
        initNav();
      });
  });

  function initNav() {
    var user = window._user;
    var nav = document.querySelector('.nav');
    if (!nav) return;

    // Clear existing nav links (keep logo)
    var logo = nav.querySelector('.nav__logo');
    nav.innerHTML = '';
    if (logo) nav.appendChild(logo);

    var links = document.createElement('div');
    links.className = 'nav__links';

    // Home is always shown
    var homeLink = document.createElement('a');
    homeLink.href = '/';
    homeLink.className = 'nav__link';
    homeLink.textContent = 'Home';
    if (window.location.pathname === '/' || window.location.pathname === '') {
      homeLink.classList.add('is-active');
    }
    links.appendChild(homeLink);

    if (user) {
      // Logged in: Submit + My Submissions + user menu
      var submitLink = document.createElement('a');
      submitLink.href = '/submit';
      submitLink.className = 'nav__link';
      submitLink.textContent = 'Submit';
      if (window.location.pathname === '/submit') {
        submitLink.classList.add('is-active');
      }
      links.appendChild(submitLink);

      var mySubLink = document.createElement('a');
      mySubLink.href = '/my-submissions';
      mySubLink.className = 'nav__link';
      mySubLink.id = 'nav-my-submissions';

      var mySubText = document.createTextNode('My Submissions');
      mySubLink.appendChild(mySubText);

      // Badge for unread notifications
      var badge = document.createElement('span');
      badge.className = 'nav__badge';
      badge.id = 'nav-notification-badge';
      badge.textContent = '';
      badge.style.display = 'none';
      mySubLink.appendChild(badge);

      if (window.location.pathname === '/my-submissions') {
        mySubLink.classList.add('is-active');
      }
      links.appendChild(mySubLink);

      // Fetch unread count
      // v=11: notification badge fetches from /api/user-submissions?action=notifications
      fetch('/api/user-submissions?action=notifications')
        .then(function(r) { return r.json(); })
        .then(function(data) {
          window._unreadCount = data.unread || 0;
          if (window._unreadCount > 0) {
            badge.textContent = window._unreadCount > 99 ? '99+' : String(window._unreadCount);
            badge.style.display = '';
          }
        })
        .catch(function() { /* notifications unavailable, badge stays hidden */ });

      // User menu with avatar + dropdown
      var userMenu = document.createElement('div');
      userMenu.className = 'nav__user-menu';

      var userBtn = document.createElement('button');
      userBtn.className = 'nav__user-btn';
      userBtn.title = user.username;
      if (user.avatar_url) {
        var avatar = document.createElement('img');
        avatar.className = 'nav__avatar';
        avatar.src = user.avatar_url;
        avatar.alt = user.username;
        avatar.width = 28;
        avatar.height = 28;
        userBtn.appendChild(avatar);
      } else {
        userBtn.textContent = user.username.charAt(0).toUpperCase();
      }

      var dropdown = document.createElement('div');
      dropdown.className = 'nav__dropdown';

      var profileLink = document.createElement('a');
      profileLink.href = '/profile';
      profileLink.className = 'nav__dropdown-link';
      profileLink.textContent = 'Profile';
      dropdown.appendChild(profileLink);

      var logoutBtn = document.createElement('button');
      logoutBtn.className = 'nav__dropdown-logout';
      logoutBtn.textContent = 'Log Out';
      logoutBtn.addEventListener('click', function() {
        fetch('/api/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-csrf-token': window._csrfToken || '' },
          body: JSON.stringify({ action: 'logout' }),
        }).then(function() {
          window.location.href = '/';
        });
      });
      dropdown.appendChild(logoutBtn);

      userBtn.addEventListener('click', function(e) {
        e.preventDefault();
        dropdown.classList.toggle('is-open');
      });

      // Close dropdown on outside click
      document.addEventListener('click', function(e) {
        if (!userMenu.contains(e.target)) {
          dropdown.classList.remove('is-open');
        }
      });

      userMenu.appendChild(userBtn);
      userMenu.appendChild(dropdown);
      links.appendChild(userMenu);
    } else {
      // Not logged in: only Login button
      var loginLink = document.createElement('a');
      loginLink.href = '/api/auth?action=login';
      loginLink.className = 'nav__link nav__link--login';
      loginLink.textContent = 'Login with Discord';
      links.appendChild(loginLink);
    }

    // 主题切换按钮。⚠️ 必须挂在这里，不能写在 HTML 的 <nav> 里 ——
    // 本函数上面那句 `nav.innerHTML = ''` 会把写死的节点全抹掉。
    if (window.__theme && window.__theme.mount) window.__theme.mount(links);

    nav.appendChild(links);
  }

  // Expose logout for inline scripts
  window._logout = function() {
    fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': window._csrfToken || '' },
      body: JSON.stringify({ action: 'logout' }),
    }).then(function() {
      window.location.href = '/';
    });
  };
})();
