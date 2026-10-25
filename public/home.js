(function () {
    async function loadBanners() {
        const carousel = document.getElementById('bsCarousel');
        if (!carousel) return;

        try {
            const response = await fetch('/api/banners');
            if (!response.ok) {
                throw new Error('โหลด Banner ไม่สำเร็จ');
            }
            const data = await response.json();
            if (!Array.isArray(data.banners)) {
                throw new Error('รูปแบบข้อมูล Banner ไม่ถูกต้อง');
            }

            const indicators = carousel.querySelector('.carousel-indicators');
            const inner = carousel.querySelector('.carousel-inner');
            $('#bsCarousel').carousel('dispose');
            indicators.replaceChildren();
            inner.replaceChildren();

            data.banners.forEach(function (banner, index) {
                const indicator = document.createElement('li');
                indicator.dataset.target = '#bsCarousel';
                indicator.dataset.slideTo = String(index);
                if (index === 0) indicator.className = 'active';
                indicators.append(indicator);

                const item = document.createElement('div');
                item.className = 'carousel-item' + (index === 0 ? ' active' : '');
                const image = document.createElement('img');
                image.className = 'd-block';
                image.src = banner.image;
                image.alt = banner.altText || '';
                item.append(image);
                inner.append(item);
            });

            carousel.classList.toggle('d-none', data.banners.length === 0);
            if (data.banners.length) {
                $('#bsCarousel').carousel({ interval: 5000, ride: 'carousel' });
            }
        } catch (error) {
            console.error(error);
        }
    }

    loadBanners();
}());