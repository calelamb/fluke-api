import { PrismaClient } from '@prisma/client';

// Whale bios are written from public sources and represent the project author's
// understanding as of seed time. Authoritative catalogs are maintained by:
//   - Center for Whale Research (Southern Residents): https://www.whaleresearch.com/
//   - Bigg's Killer Whale ID Project (Transients): https://www.bcwhales.org/
//   - Orca Network (sightings & history): https://www.orcanetwork.org/
// For any individual, defer to those sources over this seed data.

const prisma = new PrismaClient();

const whales = [
  {
    catalogId: 'J2',
    name: 'Granny',
    ecotype: 'RESIDENT' as const,
    pod: 'J',
    sex: 'FEMALE' as const,
    birthYear: 1911,
    deathYear: 2016,
    status: 'DECEASED' as const,
    biography: 'For decades the matriarch of J pod, Granny was widely described as one of the oldest known orcas in the world. Her exact birth year is debated: the original 1911 estimate has been contested by more recent analysis, and her true age may never be known with certainty. What is not disputed is her significance. Granny was one of the longest-documented Southern Resident killer whales, led her family through the Salish Sea into old age, and became a public symbol of orca longevity and matrilineal social structure.',
    distinguishingMarks: 'A distinctive half-moon nick midway down the trailing edge of her dorsal fin.',
  },
  {
    catalogId: 'J35',
    name: 'Tahlequah',
    ecotype: 'RESIDENT' as const,
    pod: 'J',
    sex: 'FEMALE' as const,
    birthYear: 1998,
    status: 'ALIVE' as const,
    biography: 'In 2018, Tahlequah carried her deceased newborn calf for seventeen days across more than a thousand miles of the Salish Sea in what researchers described as an unprecedented display of grief. The world watched. She has since given birth to two more calves, J57 and J61, both alive at the time of writing.',
    distinguishingMarks: 'Slightly curved dorsal fin with a clean trailing edge.',
  },
  {
    catalogId: 'J17',
    name: 'Princess Angeline',
    ecotype: 'RESIDENT' as const,
    pod: 'J',
    sex: 'FEMALE' as const,
    birthYear: 1977,
    deathYear: 2019,
    status: 'DECEASED' as const,
    biography: 'Mother of Tahlequah (J35) and matriarch of one of J pod\'s most prominent matrilines. Her death in 2019 was widely attributed to malnutrition linked to declining Chinook salmon populations, drawing renewed attention to the food-supply crisis facing Southern Resident killer whales.',
    distinguishingMarks: 'Tall, straight female dorsal fin.',
  },
  {
    catalogId: 'J16',
    name: 'Slick',
    ecotype: 'RESIDENT' as const,
    pod: 'J',
    sex: 'FEMALE' as const,
    birthYear: 1972,
    status: 'ALIVE' as const,
    biography: 'One of the older living members of J pod and a respected matriarch within her family group. Slick has been observed in the Salish Sea for over five decades, making her presence a near-constant of summer orca-watching in the San Juan Islands.',
  },
  {
    catalogId: 'J26',
    name: 'Mike',
    ecotype: 'RESIDENT' as const,
    pod: 'J',
    sex: 'MALE' as const,
    birthYear: 1991,
    status: 'ALIVE' as const,
    biography: 'A large adult male of J pod, easily identified by his towering dorsal fin - a defining feature of mature male orcas, which can reach over six feet in height. Mike has been documented for decades and is one of the more reliably-sighted males of the Southern Resident community.',
    distinguishingMarks: 'Towering male dorsal fin, characteristic of post-sprouter adult males.',
  },
  {
    catalogId: 'L87',
    name: 'Onyx',
    ecotype: 'RESIDENT' as const,
    pod: 'L',
    sex: 'MALE' as const,
    birthYear: 1992,
    status: 'ALIVE' as const,
    biography: 'Onyx is unusual among Southern Residents for having moved between pods after the death of his mother - first joining K pod, then traveling extensively with J pod. His behavior provides researchers a rare window into the flexibility of orca social bonds across pod lines.',
  },
  {
    catalogId: 'L25',
    name: 'Tokitae',
    ecotype: 'RESIDENT' as const,
    pod: 'L',
    sex: 'FEMALE' as const,
    birthYear: 1965,
    deathYear: 2023,
    status: 'DECEASED' as const,
    biography: 'Captured from Penn Cove in 1970 at approximately four years of age, Tokitae - also known as Lolita - spent more than five decades in captivity at the Miami Seaquarium. Plans to return her to a sea sanctuary in the Salish Sea were underway when she died in August 2023. Her story became a defining chapter in the international movement to end orca captivity.',
  },
  {
    catalogId: 'T065A2',
    name: null,
    ecotype: 'BIGGS' as const,
    pod: 'T065A matriline',
    sex: 'MALE' as const,
    birthYear: null,
    status: 'ALIVE' as const,
    biography: 'An estimated mature member of the T065A matriline, one of the frequently-sighted Bigg\'s killer whale family groups in the Salish Sea. Bigg\'s orcas - also called transients - hunt marine mammals such as harbor seals, porpoises, and sea lions, and travel in smaller, quieter groups than fish-eating Residents. Bigg\'s individual identification details are best maintained by the Bigg\'s Killer Whale ID Project; defer to that catalog for definitive information.',
  },
  {
    catalogId: 'T049A1',
    name: null,
    ecotype: 'BIGGS' as const,
    pod: 'T049A matriline',
    sex: 'MALE' as const,
    birthYear: 2001,
    status: 'ALIVE' as const,
    biography: 'A large adult male of the T049A matriline, identifiable to trained observers by his tall dorsal fin and saddle patch pattern. Bigg\'s killer whales have shown a population increase in recent decades, in contrast to the declining trend among Southern Residents. Bigg\'s individual identification details are best maintained by the Bigg\'s Killer Whale ID Project; defer to that catalog for definitive information.',
  },
  {
    catalogId: 'T037A1B',
    name: null,
    ecotype: 'BIGGS' as const,
    pod: 'T037A matriline',
    sex: 'UNKNOWN' as const,
    birthYear: null,
    status: 'ALIVE' as const,
    biography: 'An estimated young member of the T037A matriline, documented in the past several years traveling with close relatives throughout the Salish Sea. The growth and stability of Bigg\'s matrilines like T037A reflects the resilience of marine-mammal-eating orca populations along the Pacific Northwest coast. Bigg\'s individual identification details are best maintained by the Bigg\'s Killer Whale ID Project; defer to that catalog for definitive information.',
  },
];

async function main() {
  console.log('Seeding whales...');
  for (const w of whales) {
    await prisma.whale.upsert({
      where: { catalogId: w.catalogId },
      create: w,
      update: w,
    });
    console.log(`  - ${w.catalogId}${w.name ? ` (${w.name})` : ''}`);
  }

  console.log('Setting lineage...');
  const j17 = await prisma.whale.findUnique({ where: { catalogId: 'J17' } });
  const j35 = await prisma.whale.findUnique({ where: { catalogId: 'J35' } });
  if (j17 && j35) {
    await prisma.whale.update({
      where: { id: j35.id },
      data: { motherId: j17.id },
    });
    console.log('  - J35 -> mother J17');
  }

  console.log(`\nSeeded ${whales.length} whales successfully.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
