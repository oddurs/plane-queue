/**
 * The evidence behind the model, stated where the numbers are actually used.
 * Every timing constant in the engine traces back to something on this list.
 */

interface Source {
  cite: string;
  url: string;
  takeaway: string;
}

const SOURCES: Source[] = [
  {
    cite: 'Steffen & Hotchkiss (2011), “Experimental test of airplane boarding methods”, J. Air Transport Management',
    url: 'https://arxiv.org/abs/1108.5211',
    takeaway:
      'Boarded 72 volunteers into a mock 757 (12 rows × 6 seats) five times, once per method. The only physical ground truth of its kind — this simulator’s timing constants are fitted to it.',
  },
  {
    cite: 'Steffen (2008), “Optimal boarding method for airline passengers”, J. Air Transport Management',
    url: 'https://arxiv.org/abs/0802.0733',
    takeaway:
      'Derived the optimal order by Markov Chain Monte Carlo. The insight: boarding time is set by how many people can stow luggage at once, so the goal is to spread the queue along the cabin, not to fill it tidily.',
  },
  {
    cite: 'van den Briel et al. (2005), “America West Airlines develops efficient boarding strategies”, Interfaces',
    url: 'https://pubsonline.informs.org/doi/10.1287/inte.1050.0135',
    takeaway:
      'Introduced reverse pyramid. ~15% faster than random in simulation; in service it cut average boarding by over two minutes on full flights.',
  },
  {
    cite: 'Schultz (2018), “Implementation and application of a stochastic aircraft boarding model”, Transportation Research Part C',
    url: 'https://www.sciencedirect.com/science/article/abs/pii/S0968090X18303735',
    takeaway:
      'Stochastic agent model: luggage stow time drawn from a triangular distribution scaled by number of items — the approach used here.',
  },
  {
    cite: 'Ferrari & Nagel (2005) and later cellular-automaton studies',
    url: 'https://www.mdpi.com/2071-1050/10/11/4217',
    takeaway:
      'Established the seat-interference taxonomy and showed that order-dependent methods degrade sharply when passengers do not comply, while block methods are robust to it.',
  },
];

const MEASURED: [string, string][] = [
  ['Steffen (perfect order)', '3:36'],
  ['Outside-in (WilMA)', '4:13'],
  ['Random, assigned seats', '4:44'],
  ['Back-to-front, by row', '6:11'],
  ['Blocks (3 × 4 rows)', '6:54'],
];

export function buildResearch(host: HTMLElement): void {
  host.classList.add('research');
  host.innerHTML = `
      <div class="block-bar"><h2>Where these numbers come from</h2></div>
      <div class="research-body">
        <div class="research-col">
          <h3>Measured — mock 757, 72 passengers</h3>
          <table class="measured">
            <tbody>
              ${MEASURED.map(
                ([name, time]) => `<tr><td>${name}</td><td>${time}</td></tr>`,
              ).join('')}
            </tbody>
          </table>
          <p class="note">
            Steffen &amp; Hotchkiss ran each method once, and put the uncertainty
            on a single run at roughly 10%. This simulator reproduces the ordering
            and lands within about 7% on Wilma, random and back-to-front. It runs
            perfect Steffen faster than the measured 3:36, because the real run
            was knowingly imperfect — parent-child pairs boarded first and some
            people sat in the wrong seat. It also rates 4-row block boarding
            better than the measured result, since larger blocks genuinely let
            more people stow at once; that particular gap in the experiment sits
            inside its own error bar.
          </p>
        </div>
        <div class="research-col">
          <h3>Constants the engine uses</h3>
          <ul class="constants">
            <li><strong>~5s</strong> of aisle blockage per passenger stowing a bag and sitting down</li>
            <li><strong>~2s</strong> per seated neighbour who has to stand up</li>
            <li><strong>1.2s</strong> to walk past one row</li>
            <li>Back-to-front, done properly, produces <strong>zero</strong> seat interferences — and 71 aisle ones</li>
          </ul>
        </div>
      </div>
      <ol class="sources">
        ${SOURCES.map(
          (s) =>
            `<li><a href="${s.url}" target="_blank" rel="noreferrer">${s.cite}</a><span>${s.takeaway}</span></li>`,
        ).join('')}
      </ol>
  `;
}
