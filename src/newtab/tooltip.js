
/**
 * Generic Tooltip utility for Tabtopia
 * Provides D3-style floating tooltips for standard DOM elements
 */
export class Tooltip {
    constructor(id = 'global-tooltip') {
        this.id = id;
        this.element = this._getOrCreateElement();
        this.isActive = false;
    }

    /**
     * Finds or creates the tooltip DOM element
     * @private
     */
    _getOrCreateElement() {
        let el = document.getElementById(this.id);
        if (!el) {
            el = document.createElement('div');
            el.id = this.id;
            el.className = 'awesome-tooltip';
            document.body.appendChild(el);
        }
        return el;
    }

    /**
     * Show the tooltip with specified content at cursor position
     * @param {string} content - HTML content to show
     * @param {MouseEvent} event - Mouse event for positioning
     */
    show(content, event) {
        if (!content) return;

        this.element.innerHTML = content;
        this.element.style.opacity = '1';
        this.element.style.visibility = 'visible';
        this.isActive = true;

        this.move(event);
    }

    /**
     * Move the tooltip based on mouse event
     * @param {MouseEvent} event 
     */
    move(event) {
        if (!this.isActive) return;

        const x = event.pageX + 15;
        const y = event.pageY - 10;

        // Keep within viewport bounds
        const tooltipWidth = this.element.offsetWidth;
        const tooltipHeight = this.element.offsetHeight;
        const pageWidth = window.innerWidth;
        const pageHeight = window.innerHeight;

        let finalX = x;
        let finalY = y;

        if (x + tooltipWidth > pageWidth) {
            finalX = event.pageX - tooltipWidth - 15;
        }

        if (y + tooltipHeight > pageHeight) {
            finalY = event.pageY - tooltipHeight - 10;
        }

        this.element.style.left = `${finalX}px`;
        this.element.style.top = `${finalY}px`;
    }

    /**
     * Hide the tooltip
     */
    hide() {
        this.element.style.opacity = '0';
        this.element.style.visibility = 'hidden';
        this.isActive = false;
    }

    /**
     * Attach tooltip behavior to an element
     * @param {HTMLElement} target - Element to attach to
     * @param {Function} contentFn - Function that returns HTML content
     */
    attach(target, contentFn) {
        target.addEventListener('mouseenter', (e) => {
            const content = contentFn(target);
            this.show(content, e);
        });

        target.addEventListener('mousemove', (e) => {
            this.move(e);
        });

        target.addEventListener('mouseleave', () => {
            this.hide();
        });
    }
}

export const globalTooltip = new Tooltip();
