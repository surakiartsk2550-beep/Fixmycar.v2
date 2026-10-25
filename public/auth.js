(function () {
    const authButton = document.getElementById('authButton');
    const adminNavItem = document.getElementById('adminNavItem');
    let authenticationState = 'checking';

    function showLoginButton() {
        authenticationState = 'unauthenticated';
        if (adminNavItem) {
            adminNavItem.classList.add('d-none');
        }
        authButton.href = 'login.html';
        authButton.textContent = 'เข้าสู่ระบบ';
    }

    function showLogoutButton(user) {
        authenticationState = 'authenticated';
        if (adminNavItem) {
            adminNavItem.classList.toggle('d-none', !user.isAdmin);
        }
        authButton.removeAttribute('href');
        authButton.textContent = 'ออกจากระบบ';
    }

    async function checkAuthentication() {
        const response = await fetch('/api/auth/me');
        if (response.status === 401) {
            showLoginButton();
            return false;
        }
        if (!response.ok) {
            throw new Error('ตรวจสอบสถานะการเข้าสู่ระบบไม่สำเร็จ');
        }

        const data = await response.json();
        showLogoutButton(data.user);
        return true;
    }

    async function logout() {
        authButton.setAttribute('aria-disabled', 'true');
        try {
            const response = await fetch('/api/auth/logout', { method: 'POST' });
            if (!response.ok) {
                throw new Error('ออกจากระบบไม่สำเร็จ กรุณาลองใหม่');
            }
            showLoginButton();
        } catch (error) {
            console.error(error);
            alert(error.message || 'ออกจากระบบไม่สำเร็จ กรุณาลองใหม่');
        } finally {
            authButton.removeAttribute('aria-disabled');
        }
    }

    if (authButton) {
        authButton.addEventListener('click', function (event) {
            if (authenticationState === 'authenticated') {
                event.preventDefault();
                logout();
            } else if (authenticationState === 'checking') {
                event.preventDefault();
                checkAuthentication().then(function (isAuthenticated) {
                    if (isAuthenticated) {
                        logout();
                    } else {
                        window.location.assign('login.html');
                    }
                }).catch(function (error) {
                    console.error(error);
                    alert(error.message);
                });
            }
        });

        checkAuthentication().catch(function (error) {
            console.error(error);
        });
    }

    window.FixMyCarAuth = {
        requireAuthenticated: async function (action, message) {
            try {
                if (await checkAuthentication()) {
                    action();
                } else {
                    alert(message || 'กรุณาเข้าสู่ระบบก่อนใช้งาน');
                    window.location.assign('login.html');
                }
            } catch (error) {
                console.error(error);
                alert(error.message || 'ตรวจสอบสถานะการเข้าสู่ระบบไม่สำเร็จ');
            }
        }
    };
}());
