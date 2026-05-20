"electron_1.contextBridge.exposeInMainWorld('deepLink', deepLinkAPI);
electron_1.contextBridge.exposeInMainWorld('agent', agentAPI);
electron_1.contextBridge.exposeInMainWorld('electronNative', electronNativeAPI);

window.addEventListener('DOMContentLoaded', () => {
    function findRefreshButton() {
        const buttons = Array.from(document.querySelectorAll('button'));
        return buttons.find(b => b.textContent.trim() === 'Refresh');
    }
    
    function hasModelsHeading() {
        const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, div'));
        return headings.some(h => h.textContent.trim() === 'Models');
    }
    
    function injectAddModelUI() {
        const refreshBtn = findRefreshButton();
        if (!refreshBtn) return;
        if (!hasModelsHeading()) return;
        if (document.getElementById('agy-add-model-btn')) return;
        
        const addModelBtn = document.createElement('button');
        addModelBtn.id = 'agy-add-model-btn';
        addModelBtn.textContent = 'Add Model';
        
        // Copy classes from Refresh button to match native styling
        addModelBtn.className = refreshBtn.className;
        
        // Custom styling for a modern, gorgeous button with hover transition
        addModelBtn.style.marginRight = '12px';
        addModelBtn.style.backgroundImage = 'linear-gradient(135deg, #6366f1, #4f46e5)'; // Indigo gradient
        addModelBtn.style.color = '#ffffff';
        addModelBtn.style.border = 'none';
        addModelBtn.style.cursor = 'pointer';
        addModelBtn.style.transition = 'opacity 0.15s ease';
        
        addModelBtn.addEventListener('mouseenter', () => {
            addModelBtn.style.opacity = '0.9';
        });
        addModelBtn.addEventListener('mouseleave', () => {
            addModelBtn.style.opacity = '1';
        });
        
        // Insert it right before the Refresh button
        refreshBtn.parentNode.insertBefore(addModelBtn, refreshBtn);
        
      
<truncated 14111 bytes>